// Embeddings for the suggest function (WS06). docs/03-ai-design.md §3 step 1 and §1 (Voyage
// `voyage-3`, 1024 dimensions).
//
//   * Recipes: `embedMissingRecipes` fills `recipes.embedding` from title, cuisine, tags, and main
//     ingredient names. WS02 left the column empty, so this is also the backfill path.
//   * People: `buildTasteEmbedding` turns preferences and what a person liked into one vector for
//     `profiles.taste_embedding`. A short description of their taste (written by Haiku, or by the
//     plain-text fallback when no model is available) is embedded as a query and blended with the
//     average of the vectors of the dinners they liked.
//
// Everything that needs a key is injected, so without VOYAGE_API_KEY none of this runs and the
// pipeline ranks by popularity and cuisine instead.
import type { ProfilePreferences } from "../../../packages/core/src/index.ts";
import {
  type AiRunSink,
  type CostGuard,
  EMBEDDING_DIMENSIONS,
  extract,
  formatVector,
  type MessagesClient,
  SUGGEST_TASTE_SUMMARY_V1,
  TasteSummary,
  type TasteSummaryVars,
} from "../../../packages/llm/src/index.ts";
import type { SqlRunner } from "./candidates.ts";

/** Embeds texts. The handler binds logging, the cost guard, and the key. */
export type EmbedFn = (
  texts: readonly string[],
  inputType: "document" | "query",
) => Promise<number[][]>;

const RECIPE_TEXT_MAX_CHARS = 1500;

export interface RecipeEmbeddingSource {
  title: string;
  cuisine: string | null;
  tags: readonly string[];
  /** Main ingredient names, best first. */
  ingredients: readonly string[];
}

/** The text a recipe is embedded from: title + cuisine + tags + ingredient names (docs/02). */
export function recipeEmbeddingText(recipe: RecipeEmbeddingSource): string {
  const parts = [
    recipe.title.trim(),
    recipe.cuisine ? `cuisine: ${recipe.cuisine.trim()}` : null,
    recipe.tags.length > 0 ? `tags: ${recipe.tags.slice(0, 12).join(", ")}` : null,
    recipe.ingredients.length > 0
      ? `ingredients: ${recipe.ingredients.slice(0, 20).join(", ")}`
      : null,
  ];
  return parts
    .filter((part): part is string => Boolean(part))
    .join(" | ")
    .slice(0, RECIPE_TEXT_MAX_CHARS);
}

/** Parses pgvector's text form, for example [0.1,0.2]. Null when it is not a vector of our size. */
export function parseVector(text: string | null | undefined): number[] | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  const values = trimmed
    .slice(1, -1)
    .split(",")
    .map((part) => Number(part));
  if (values.length !== EMBEDDING_DIMENSIONS || values.some((v) => !Number.isFinite(v)))
    return null;
  return values;
}

function norm(vector: readonly number[]): number {
  let sum = 0;
  for (const v of vector) sum += v * v;
  return Math.sqrt(sum);
}

/**
 * A weighted sum of vectors scaled to unit length. Cosine distance ignores length, so scaling
 * only keeps the numbers tidy. Returns null for no input or a sum of zero.
 */
export function blendEmbeddings(
  parts: readonly { vector: readonly number[]; weight: number }[],
): number[] | null {
  const usable = parts.filter((part) => part.weight > 0 && part.vector.length > 0);
  const first = usable[0];
  if (!first) return null;
  const size = first.vector.length;
  const sum = new Array<number>(size).fill(0);
  for (const part of usable) {
    if (part.vector.length !== size) throw new Error("embeddings differ in size");
    // Unit length first, so a part's weight is its influence and not its magnitude.
    const length = norm(part.vector) || 1;
    for (let i = 0; i < size; i++)
      sum[i] = (sum[i] ?? 0) + ((part.vector[i] ?? 0) / length) * part.weight;
  }
  const length = norm(sum);
  if (length === 0) return null;
  return sum.map((v) => Math.round((v / length) * 1e6) / 1e6);
}

/** Plain-text taste description for when no model is available to write a better one. */
export function plainTasteSummary(vars: TasteSummaryVars): string {
  const parts: string[] = [];
  if (vars.cuisines.length > 0) parts.push(`Likes ${vars.cuisines.join(", ")} cooking.`);
  if (vars.liked.length > 0) parts.push(`Enjoyed ${vars.liked.slice(0, 8).join(", ")}.`);
  if (vars.skipped.length > 0) parts.push(`Passed on ${vars.skipped.slice(0, 6).join(", ")}.`);
  if (vars.weeknightMinutes)
    parts.push(`Weeknight dinners in about ${vars.weeknightMinutes} minutes.`);
  if (vars.skill) parts.push(`${vars.skill} cook.`);
  if (vars.notes) parts.push(vars.notes);
  return (parts.join(" ") || "Everyday home cooking.").slice(0, 600);
}

export function tasteVarsFrom(
  preferences: ProfilePreferences,
  liked: readonly string[],
  skipped: readonly string[],
): TasteSummaryVars {
  return {
    cuisines: preferences.cuisines ?? [],
    skill: preferences.skill,
    weeknightMinutes: preferences.weeknight_minutes ?? null,
    leftovers: preferences.leftovers,
    equipment: preferences.equipment ?? [],
    liked,
    skipped,
    notes: preferences.notes,
  };
}

export interface SummaryDeps {
  client?: MessagesClient | undefined;
  apiKey?: string | undefined;
  log?: AiRunSink | undefined;
  guard?: CostGuard | undefined;
  householdId: string | null;
}

/**
 * Haiku's description of a person's taste, or the plain-text fallback when no key is set, the
 * budget is spent, or the call fails. The summary only steers recipe search, so a failure here is
 * never an error for the person.
 */
export async function summarizeTaste(
  vars: TasteSummaryVars,
  deps: SummaryDeps,
  warn: (message: string) => void = console.warn,
): Promise<{ text: string; source: "model" | "plain" }> {
  if (!deps.client && !deps.apiKey) return { text: plainTasteSummary(vars), source: "plain" };
  try {
    const result = await extract(
      TasteSummary,
      {
        system: SUGGEST_TASTE_SUMMARY_V1.system(),
        user: SUGGEST_TASTE_SUMMARY_V1.user(vars),
        model: SUGGEST_TASTE_SUMMARY_V1.model,
        kind: SUGGEST_TASTE_SUMMARY_V1.kind,
        promptVersion: SUGGEST_TASTE_SUMMARY_V1.id,
        householdId: deps.householdId,
        maxTokens: 600,
      },
      {
        ...(deps.client ? { client: deps.client } : {}),
        ...(deps.apiKey ? { apiKey: deps.apiKey } : {}),
        ...(deps.log ? { log: deps.log } : {}),
        ...(deps.guard ? { guard: deps.guard } : {}),
      },
    );
    return { text: result.value.summary, source: "model" };
  } catch (err) {
    warn(
      `suggest: taste summary fell back to plain text (${err instanceof Error ? err.message : String(err)})`,
    );
    return { text: plainTasteSummary(vars), source: "plain" };
  }
}

export interface TasteEmbeddingInput {
  preferences: ProfilePreferences;
  /** Dinners the person liked, with their vectors when the recipe has one. */
  liked: readonly { title: string; embedding: number[] | null }[];
  skipped: readonly string[];
}

export interface TasteEmbeddingDeps extends SummaryDeps {
  embed: EmbedFn;
}

/** How much of the final vector comes from the liked dinners, once there are any. */
export const LIKED_WEIGHT = 0.5;

/** The vector for `profiles.taste_embedding`, with the summary it came from. */
export async function buildTasteEmbedding(
  input: TasteEmbeddingInput,
  deps: TasteEmbeddingDeps,
  warn?: (message: string) => void,
): Promise<{ vector: number[]; summary: string; summarySource: "model" | "plain" } | null> {
  const vars = tasteVarsFrom(
    input.preferences,
    input.liked.map((item) => item.title),
    input.skipped,
  );
  const summary = await summarizeTaste(vars, deps, warn);
  const [summaryVector] = await deps.embed([summary.text], "query");
  if (!summaryVector) return null;

  const likedVectors = input.liked
    .map((item) => item.embedding)
    .filter((vector): vector is number[] => vector !== null);
  const likedMean = blendEmbeddings(likedVectors.map((vector) => ({ vector, weight: 1 })));
  const vector = blendEmbeddings([
    { vector: summaryVector, weight: likedMean ? 1 - LIKED_WEIGHT : 1 },
    ...(likedMean ? [{ vector: likedMean, weight: LIKED_WEIGHT }] : []),
  ]);
  return vector ? { vector, summary: summary.text, summarySource: summary.source } : null;
}

// ---------------------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------------------

interface MissingRow {
  id: string;
  title: string;
  cuisine: string | null;
  tags: string[] | null;
}

interface IngredientNameRow {
  recipe_id: string;
  name: string;
}

export interface BackfillResult {
  embedded: number;
  /** Recipes visible to the household (its own and the catalog) that still have no embedding. */
  remaining: number;
}

/**
 * Embeds up to `limit` recipes that have no embedding and stores the vectors: the household's own
 * first, oldest first, then the starter catalog (`visibility = 'catalog'`, shared by every
 * household, so any household's call may fill it). Safe to call repeatedly: it only touches rows
 * whose embedding is null, so a second call finds less to do and the same rows never change.
 */
export async function embedMissingRecipes(
  sql: SqlRunner,
  options: { householdId: string; limit: number; embed: EmbedFn },
): Promise<BackfillResult> {
  const rows = await sql.query<MissingRow>(
    `select r.id, r.title, r.cuisine, r.tags
       from public.recipes r
      where (r.household_id = $1::uuid or r.visibility = 'catalog')
        and r.embedding is null and r.deleted_at is null
      order by (r.household_id is null), r.created_at, r.id
      limit $2::int`,
    [options.householdId, options.limit],
  );
  if (rows.length > 0) {
    const names = await sql.query<IngredientNameRow>(
      `select ri.recipe_id, coalesce(i.name, ri.raw_text) as name
         from public.recipe_ingredients ri
         left join public.ingredients i on i.id = ri.ingredient_id
        where ri.recipe_id = any($1::uuid[]) and coalesce(i.is_staple_default, false) = false
        order by ri.recipe_id, ri.position`,
      [rows.map((row) => row.id)],
    );
    const byRecipe = new Map<string, string[]>();
    for (const row of names) {
      const list = byRecipe.get(row.recipe_id) ?? [];
      list.push(row.name.trim().slice(0, 60));
      byRecipe.set(row.recipe_id, list);
    }
    const texts = rows.map((row) =>
      recipeEmbeddingText({
        title: row.title,
        cuisine: row.cuisine,
        tags: row.tags ?? [],
        ingredients: byRecipe.get(row.id) ?? [],
      }),
    );
    const vectors = await options.embed(texts, "document");
    for (const [i, row] of rows.entries()) {
      const vector = vectors[i];
      if (!vector) continue;
      await sql.query(
        `update public.recipes set embedding = $1::extensions.vector
          where id = $2::uuid and embedding is null
            and (household_id = $3::uuid or visibility = 'catalog')`,
        [formatVector(vector), row.id, options.householdId],
      );
    }
  }
  const remaining = await sql.query<{ n: number | string }>(
    `select count(*)::int as n from public.recipes
      where (household_id = $1::uuid or visibility = 'catalog')
        and embedding is null and deleted_at is null`,
    [options.householdId],
  );
  return { embedded: rows.length, remaining: Number(remaining[0]?.n ?? 0) };
}
