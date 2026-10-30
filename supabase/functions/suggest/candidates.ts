// Candidate retrieval for the suggest function (WS06). docs/03-ai-design.md §3 steps 1 and 2.
//
//   1. filters.ts builds the SQL; one query returns the household's recipes and the catalog that
//      pass every hard filter, nearest to the taste embedding first.
//   2. History is added: what the household liked, cooked lately, or skipped, and how popular a
//      recipe is across households (the cold-start signal when there is no taste embedding).
//   3. A score ranks the pool; the top 60 are the composer's candidates.
//   4. The ingredient lines of those 60 are read back and checked against the filters in
//      TypeScript. A recipe that fails is dropped and reported, never shown. This repeats the SQL
//      on purpose (R4): the model only ever sees recipes both checks passed.
//
// The database is reached through `SqlRunner`, so the function uses a Postgres driver and the
// tests use PGlite with the same SQL.
import type { CalibrationCard } from "../../../packages/core/src/index.ts";
import {
  buildCandidateQuery,
  type FilterSpec,
  findViolations,
  type RecipeLine,
} from "./filters.ts";

/**
 * What the suggest function needs from a database: run SQL with parameters and get rows back, and
 * run several statements as one transaction. The function backs it with a Postgres driver; the
 * tests back it with PGlite.
 */
export interface SqlRunner {
  query<T = Record<string, unknown>>(text: string, params: readonly unknown[]): Promise<T[]>;
  /** Runs `fn` in one transaction: it commits when `fn` returns and rolls back when it throws. */
  transaction<T>(fn: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

/** How many recipes the composer is shown. */
export const MAX_CANDIDATES = 60;
/** How many rows the retrieval query returns before ranking trims them to MAX_CANDIDATES. */
export const POOL_SIZE = 200;

interface CandidateRow {
  id: string;
  household_id: string | null;
  visibility: "household" | "catalog";
  title: string;
  description: string | null;
  image_url: string | null;
  source_url: string | null;
  cuisine: string | null;
  tags: string[] | null;
  servings: number | string | null;
  total_min: number | string | null;
  similarity: number | string | null;
}

interface FeedbackRow {
  recipe_id: string;
  signal: string;
  n: number | string;
  last_at: string | Date | null;
}

interface PopularityRow {
  recipe_id: string;
  likes: number | string;
}

interface LineRow {
  recipe_id: string;
  position: number | string;
  raw_text: string;
  ingredient_id: string | null;
  ingredient_name: string | null;
  category: string | null;
  is_staple_default: boolean | null;
}

export interface Candidate {
  id: string;
  /** Null for a catalog recipe. */
  householdId: string | null;
  visibility: "household" | "catalog";
  title: string;
  description: string | null;
  imageUrl: string | null;
  /** Where an imported recipe came from. Shown with the recipe as attribution. */
  sourceUrl: string | null;
  cuisine: string | null;
  tags: string[];
  servings: number | null;
  /** Prep plus cook minutes; null when the recipe carries no time. */
  totalMin: number | null;
  /** Cosine similarity to the taste embedding, or null on a cold profile. */
  similarity: number | null;
  score: number;
  /** Up to six distinct ingredient names that are not pantry staples. */
  mainIngredients: string[];
}

export interface History {
  /** Likes this household gave the recipe. */
  likes: number;
  skips: number;
  /** When the household last cooked it. */
  lastCookedAt: Date | null;
  /** Likes from every household. */
  popularity: number;
}

export interface RankContext {
  cuisines: readonly string[];
  history: ReadonlyMap<string, History>;
  now: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function num(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The ranking score. A taste embedding match is the main term. Smaller terms: the cuisine the
 * person named, recipes the household liked, popularity across households (what a cold profile
 * runs on), the household's own recipes over the catalog, and a penalty for dinners cooked in
 * the last weeks so the plan does not repeat itself. Ties break on title, then id, so a run is
 * repeatable.
 */
export function scoreCandidate(
  base: {
    similarity: number | null;
    cuisine: string | null;
    visibility: "household" | "catalog";
    id: string;
  },
  context: RankContext,
): number {
  const history = context.history.get(base.id);
  let score = base.similarity ?? 0;
  const cuisine = base.cuisine?.trim().toLowerCase();
  if (cuisine && context.cuisines.some((wanted) => wanted.trim().toLowerCase() === cuisine)) {
    score += 0.12;
  }
  if (history) {
    score += Math.min(history.likes, 2) * 0.08;
    score -= Math.min(history.skips, 2) * 0.05;
    score += (Math.log1p(history.popularity) / Math.log1p(50)) * 0.08;
    if (history.lastCookedAt) {
      const days = (context.now.getTime() - history.lastCookedAt.getTime()) / DAY_MS;
      if (days <= 14) score -= 0.25;
      else if (days <= 28) score -= 0.1;
    }
  }
  if (base.visibility === "household") score += 0.05;
  return score;
}

function byScore(a: Candidate, b: Candidate): number {
  if (b.score !== a.score) return b.score - a.score;
  const title = a.title.localeCompare(b.title);
  return title !== 0 ? title : a.id.localeCompare(b.id);
}

export interface CandidateContext {
  householdId: string;
  spec: FilterSpec;
  /** pgvector text for the person's taste embedding, or null. */
  tasteEmbedding: string | null;
  cuisines: readonly string[];
  excludeIds?: readonly string[];
  now?: Date;
  /** Defaults to MAX_CANDIDATES. */
  limit?: number;
  /** Called with a short message when something is dropped or a lookup fails. */
  warn?: (message: string) => void;
}

export interface DroppedCandidate {
  recipeId: string;
  title: string;
  reasons: string[];
}

export interface CandidateResult {
  candidates: Candidate[];
  /** Recipes the SQL returned that the TypeScript check refused. Should always be empty. */
  dropped: DroppedCandidate[];
}

async function loadHistory(
  sql: SqlRunner,
  householdId: string,
  ids: readonly string[],
  warn: (message: string) => void,
): Promise<Map<string, History>> {
  const history = new Map<string, History>();
  if (ids.length === 0) return history;
  const entry = (id: string): History => {
    let item = history.get(id);
    if (!item) {
      item = { likes: 0, skips: 0, lastCookedAt: null, popularity: 0 };
      history.set(id, item);
    }
    return item;
  };
  try {
    const own = await sql.query<FeedbackRow>(
      `select f.recipe_id, f.signal::text as signal, count(*)::int as n, max(f.created_at) as last_at
         from public.recipe_feedback f
        where f.household_id = $1::uuid and f.recipe_id = any($2::uuid[])
        group by f.recipe_id, f.signal`,
      [householdId, [...ids]],
    );
    for (const row of own) {
      const item = entry(row.recipe_id);
      const n = num(row.n) ?? 0;
      if (row.signal === "like") item.likes += n;
      else if (row.signal === "skipped" || row.signal === "dislike") item.skips += n;
      else if (row.signal === "cooked" && row.last_at) {
        const at = new Date(row.last_at);
        if (!item.lastCookedAt || at > item.lastCookedAt) item.lastCookedAt = at;
      }
    }
    const popular = await sql.query<PopularityRow>(
      `select f.recipe_id, count(*)::int as likes
         from public.recipe_feedback f
        where f.signal = 'like' and f.recipe_id = any($1::uuid[])
        group by f.recipe_id`,
      [[...ids]],
    );
    for (const row of popular) entry(row.recipe_id).popularity = num(row.likes) ?? 0;
  } catch (err) {
    // recipe_feedback is WS04's table. Without it the ranking runs on similarity alone.
    warn(
      `suggest: feedback history unavailable (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  return history;
}

async function loadLines(
  sql: SqlRunner,
  ids: readonly string[],
): Promise<Map<string, (RecipeLine & { staple: boolean })[]>> {
  const lines = new Map<string, (RecipeLine & { staple: boolean })[]>();
  if (ids.length === 0) return lines;
  const rows = await sql.query<LineRow>(
    `select ri.recipe_id, ri.position, ri.raw_text, ri.ingredient_id,
            i.name as ingredient_name, i.category, i.is_staple_default
       from public.recipe_ingredients ri
       left join public.ingredients i on i.id = ri.ingredient_id
      where ri.recipe_id = any($1::uuid[])
      order by ri.recipe_id, ri.position`,
    [[...ids]],
  );
  for (const row of rows) {
    const list = lines.get(row.recipe_id) ?? [];
    list.push({
      rawText: row.raw_text,
      ingredientName: row.ingredient_name,
      category: row.category,
      ingredientId: row.ingredient_id,
      staple: row.is_staple_default === true,
    });
    lines.set(row.recipe_id, list);
  }
  return lines;
}

/** Up to six distinct names a person would call the main ingredients. */
export function mainIngredientsOf(lines: readonly (RecipeLine & { staple: boolean })[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const line of lines) {
    if (line.staple) continue;
    const name = (line.ingredientName ?? line.rawText).trim().slice(0, 40);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
    if (names.length === 6) break;
  }
  return names;
}

/**
 * Retrieve, rank, and re-check. Returns at most `limit` candidates, best first.
 */
export async function fetchCandidates(
  sql: SqlRunner,
  context: CandidateContext,
): Promise<CandidateResult> {
  const warn = context.warn ?? ((message: string) => console.warn(message));
  const now = context.now ?? new Date();
  const limit = context.limit ?? MAX_CANDIDATES;

  const query = buildCandidateQuery({
    householdId: context.householdId,
    spec: context.spec,
    tasteEmbedding: context.tasteEmbedding,
    ...(context.excludeIds ? { excludeIds: context.excludeIds } : {}),
    limit: POOL_SIZE,
  });
  const rows = await sql.query<CandidateRow>(query.text, query.params);
  const history = await loadHistory(
    sql,
    context.householdId,
    rows.map((row) => row.id),
    warn,
  );

  const rankContext: RankContext = { cuisines: context.cuisines, history, now };
  const ranked: Candidate[] = rows
    .map((row) => {
      const similarity = num(row.similarity);
      return {
        id: row.id,
        householdId: row.household_id,
        visibility: row.visibility,
        title: row.title,
        description: row.description,
        imageUrl: row.image_url,
        sourceUrl: row.source_url,
        cuisine: row.cuisine,
        tags: row.tags ?? [],
        servings: num(row.servings),
        totalMin: num(row.total_min),
        similarity,
        score: scoreCandidate(
          { similarity, cuisine: row.cuisine, visibility: row.visibility, id: row.id },
          rankContext,
        ),
        mainIngredients: [] as string[],
      };
    })
    .sort(byScore);

  // Check a little more than we need, so a dropped recipe does not leave a hole.
  const shortlist = ranked.slice(0, limit + 10);
  const lines = await loadLines(
    sql,
    shortlist.map((candidate) => candidate.id),
  );

  const kept: Candidate[] = [];
  const dropped: DroppedCandidate[] = [];
  for (const candidate of shortlist) {
    const recipeLines = lines.get(candidate.id) ?? [];
    const reasons = findViolations(
      { tags: candidate.tags, totalMin: candidate.totalMin, lines: recipeLines },
      context.spec,
    );
    if (reasons.length > 0) {
      dropped.push({
        recipeId: candidate.id,
        title: candidate.title,
        reasons: reasons.slice(0, 5),
      });
      warn(
        `suggest: dropped recipe ${candidate.id} after the SQL filter let it through: ${reasons[0]}`,
      );
      continue;
    }
    candidate.mainIngredients = mainIngredientsOf(recipeLines);
    kept.push(candidate);
    if (kept.length === limit) break;
  }
  return { candidates: kept, dropped };
}

// ---------------------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------------------

/**
 * Picks the cards for the swipe screen: the best-ranked recipes, but spread over cuisines so the
 * swipes teach something. Takes the top recipe of each cuisine in turn, up to `perCuisine` each,
 * then fills any remaining places in rank order.
 */
export function pickCalibration<T extends { id: string; cuisine: string | null }>(
  ranked: readonly T[],
  count: number,
  perCuisine = 2,
): T[] {
  const picked: T[] = [];
  const taken = new Set<string>();
  const counts = new Map<string, number>();
  const keyOf = (item: T) => item.cuisine?.trim().toLowerCase() || "(none)";

  for (const item of ranked) {
    if (picked.length === count) break;
    const key = keyOf(item);
    if ((counts.get(key) ?? 0) >= perCuisine) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    taken.add(item.id);
    picked.push(item);
  }
  for (const item of ranked) {
    if (picked.length === count) break;
    if (taken.has(item.id)) continue;
    taken.add(item.id);
    picked.push(item);
  }
  return picked;
}

/** What the swipe screen shows. `imageUrl` is resolved by the caller (storage paths are signed). */
export function toCalibrationCard(candidate: Candidate, imageUrl: string | null): CalibrationCard {
  return {
    recipeId: candidate.id,
    title: candidate.title,
    description: candidate.description,
    imageUrl,
    sourceUrl: candidate.sourceUrl,
    cuisine: candidate.cuisine,
    totalMin: candidate.totalMin,
    tags: candidate.tags.slice(0, 6),
  };
}
