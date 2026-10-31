import {
  type ImportRecipeFailure,
  instructionsToJson,
  NormalizedRecipe,
  type RecipeIngredient,
  RecipeInstructions,
  type RecipeSourceType,
  type RecipeWithIngredients,
} from "@mp/core";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MpClient } from "../client";
import { useSupabase } from "../context";

export const RECIPE_IMAGE_BUCKET = "recipe-images";

const RECIPE_COLUMNS =
  "id, household_id, title, description, image_url, source_type, source_url, servings, prep_min, cook_min, instructions, nutrition, tags, cuisine, visibility, created_by, created_at, updated_at, deleted_at";
const LINE_COLUMNS =
  "id, recipe_id, position, group_name, raw_text, qty, qty_max, unit, ingredient_id, prep_note, optional, parse_confidence";

export const recipeQueryKey = (id: string | null | undefined) => ["recipe", id] as const;

export type RecipeErrorCode = "not_found" | "invalid" | "duplicate" | "unknown";

/** How an existing recipe was recognised: by the link it came from, or by its title. */
export type DuplicateMatch = NonNullable<ImportRecipeFailure["matchedBy"]>;

export class RecipeError extends Error {
  readonly code: RecipeErrorCode;
  /** For `duplicate`: the household's existing recipe, and how it was recognised. */
  readonly existing: { recipeId: string; matchedBy: DuplicateMatch } | undefined;

  constructor(
    code: RecipeErrorCode,
    message?: string,
    existing?: { recipeId: string; matchedBy: DuplicateMatch },
  ) {
    super(message ?? code);
    this.name = "RecipeError";
    this.code = code;
    this.existing = existing;
  }
}

export const RECIPE_ERROR_MESSAGES: Record<RecipeErrorCode, string> = {
  not_found: "That recipe is gone or you cannot open it.",
  invalid: "Check the recipe: it needs a title and at least one ingredient.",
  duplicate: "You already have this recipe.",
  unknown: "Something went wrong. Try again.",
};

export function recipeErrorMessage(error: unknown): string {
  if (error instanceof RecipeError) return RECIPE_ERROR_MESSAGES[error.code];
  return RECIPE_ERROR_MESSAGES.unknown;
}

// ---------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------

/** A recipe with its ingredient lines in order, or null when it does not exist or is deleted. */
export async function fetchRecipe(
  client: MpClient,
  id: string,
): Promise<RecipeWithIngredients | null> {
  const recipe = await client
    .from("recipes")
    .select(RECIPE_COLUMNS)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (recipe.error) throw new RecipeError("unknown", recipe.error.message);
  if (!recipe.data) return null;

  const lines = await client
    .from("recipe_ingredients")
    .select(LINE_COLUMNS)
    .eq("recipe_id", id)
    .order("position", { ascending: true })
    .order("id", { ascending: true });
  if (lines.error) throw new RecipeError("unknown", lines.error.message);

  const instructions = RecipeInstructions.safeParse(recipe.data.instructions);
  return {
    ...(recipe.data as unknown as RecipeWithIngredients),
    instructions: instructions.success ? instructions.data : [],
    ingredients: (lines.data ?? []) as unknown as RecipeIngredient[],
  };
}

export function useRecipe(id: string | null | undefined) {
  const client = useSupabase();

  return useQuery({
    queryKey: recipeQueryKey(id),
    enabled: Boolean(id),
    queryFn: () => {
      if (!id) return Promise.resolve(null);
      return fetchRecipe(client, id);
    },
  });
}

// ---------------------------------------------------------------------------------------
// Matching ingredient lines (parse-ingredients, WS03)
// ---------------------------------------------------------------------------------------
//
// Every way a recipe gets written (an import, a typed recipe, a confirmed draft, an edit that
// changes lines) stores raw text only. These helpers then ask `parse-ingredients` to fill `qty`,
// `unit`, `ingredient_id`, `prep_note`, `optional` and `parse_confidence`, so the planner and the
// grocery list read a recipe that is already matched.
//
// Why from the app and not from `recipe-import`: typed recipes, confirmed photo and caption drafts
// and edits never pass through that function, so the app has to make this call for them anyway.
// One caller, one code path to test. The call carries the signed-in person's own token, so row
// level security decides which rows it may write, and it is idempotent: the function skips lines
// that already have a `parse_confidence`.

export const PARSE_FUNCTION = "parse-ingredients";
/** How long a save waits for matching before it lets the recipe open anyway. */
export const PARSE_BUDGET_MS = 25_000;

export type ParseOutcome =
  | { ok: true; parsedRows: number; unresolved: number }
  | { ok: false; reason: "no_session" | "catalog" | "timeout" | "failed"; message?: string };

/** True while a household recipe has an ingredient line the parser has not read. */
export function needsIngredientMatch(
  recipe: Pick<RecipeWithIngredients, "visibility" | "ingredients">,
): boolean {
  if (recipe.visibility === "catalog") return false;
  return recipe.ingredients.some((line) => line.parse_confidence === null);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Calls `parse-ingredients` with `{ recipeId }` as the signed-in person. Never throws: matching is
 * a convenience on top of a saved recipe, so a failure comes back as a value and the recipe stays
 * as it was (the detail screen offers "Match ingredients" to try again).
 */
export async function parseRecipeIngredients(
  client: MpClient,
  recipeId: string,
): Promise<ParseOutcome> {
  try {
    const { data: auth } = await client.auth.getSession();
    const token = auth.session?.access_token;
    if (!token) return { ok: false, reason: "no_session" };

    const { data, error } = await client.functions.invoke(PARSE_FUNCTION, {
      body: { recipeId },
      headers: { Authorization: `Bearer ${token}` },
    });
    if (error) return { ok: false, reason: "failed", message: error.message };
    const body = (data ?? {}) as Record<string, unknown>;
    if (body.ok !== true) {
      return {
        ok: false,
        reason: "failed",
        ...(typeof body.error === "string" ? { message: body.error } : {}),
      };
    }
    return {
      ok: true,
      parsedRows: numberOr(body.parsedRows, 0),
      unresolved: numberOr(body.unresolved, 0),
    };
  } catch (cause) {
    return {
      ok: false,
      reason: "failed",
      ...(cause instanceof Error ? { message: cause.message } : {}),
    };
  }
}

/**
 * Matches a recipe's lines and waits for it, but only up to `budgetMs`: a slow model call must not
 * hold up a recipe that is already saved. The call is not cancelled when the wait ends; `onSettled`
 * runs whenever it does finish, so a late result can still refresh what the screen shows.
 */
export async function parseWithinBudget(
  client: MpClient,
  recipeId: string,
  options: { budgetMs?: number; onSettled?: (outcome: ParseOutcome) => void } = {},
): Promise<ParseOutcome> {
  const work = parseRecipeIngredients(client, recipeId).then((outcome) => {
    options.onSettled?.(outcome);
    return outcome;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<ParseOutcome>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, reason: "timeout" }),
      options.budgetMs ?? PARSE_BUDGET_MS,
    );
  });
  try {
    return await Promise.race([work, budget]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The retry behind the "Match ingredients" button. A starter (catalog) recipe is never sent: it
 * arrives matched, belongs to nobody in the household, and the database would refuse the writes.
 */
export async function matchRecipeIngredients(
  client: MpClient,
  recipe: Pick<RecipeWithIngredients, "id" | "visibility">,
): Promise<ParseOutcome> {
  if (recipe.visibility === "catalog") return { ok: false, reason: "catalog" };
  return parseRecipeIngredients(client, recipe.id);
}

/** Refreshes what the screens show for a recipe whose lines were just matched. */
export async function refreshRecipe(queryClient: QueryClient, recipeId: string): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: recipeQueryKey(recipeId) }),
    queryClient.invalidateQueries({ queryKey: ["recipes"] }),
  ]);
}

/**
 * Saves wait for matching (so the recipe opens matched) and refresh the screens whenever it ends,
 * including after the wait gave up.
 */
export function parseAfterWrite(
  client: MpClient,
  queryClient: QueryClient,
  recipeId: string,
): Promise<ParseOutcome> {
  return parseWithinBudget(client, recipeId, {
    onSettled: (outcome) => {
      if (outcome.ok) void refreshRecipe(queryClient, recipeId);
    },
  });
}

export const MATCH_ERROR_MESSAGE =
  "We could not match the ingredients just now. Your recipe is saved. Try again in a moment.";

/** The button's action: matches, or throws a `RecipeError` whose message the screen shows. */
export async function matchOrThrow(
  client: MpClient,
  recipe: Pick<RecipeWithIngredients, "id" | "visibility">,
): Promise<Extract<ParseOutcome, { ok: true }>> {
  const outcome = await matchRecipeIngredients(client, recipe);
  if (!outcome.ok) throw new RecipeError("unknown", MATCH_ERROR_MESSAGE);
  return outcome;
}

/** "Match ingredients": reads every unread line of a household recipe. Throws when it fails. */
export function useMatchIngredients() {
  const client = useSupabase();
  const queryClient = useQueryClient();
  return useMutation<
    Extract<ParseOutcome, { ok: true }>,
    RecipeError,
    Pick<RecipeWithIngredients, "id" | "visibility">
  >({
    mutationFn: (recipe) => matchOrThrow(client, recipe),
    onSuccess: (_outcome, recipe) => refreshRecipe(queryClient, recipe.id),
  });
}

// ---------------------------------------------------------------------------------------
// Drafts: what the edit form and the import review produce
// ---------------------------------------------------------------------------------------

export interface DraftIngredient {
  /** Set for a line that already exists, so an edit keeps its parsed fields when the text is unchanged. */
  id?: string | undefined;
  rawText: string;
  groupName?: string | undefined;
}

export interface RecipeDraft {
  title: string;
  description?: string | undefined;
  /** An external http(s) URL or a path in the recipe-images bucket. */
  imageUrl?: string | undefined;
  servings?: number | undefined;
  prepMin?: number | undefined;
  cookMin?: number | undefined;
  tags?: string[] | undefined;
  cuisine?: string | undefined;
  nutrition?: Record<string, string> | undefined;
  ingredients: DraftIngredient[];
  instructions: string[];
}

export type DraftCheck =
  | { ok: true; recipe: NormalizedRecipe }
  | { ok: false; message: string; field: string };

/** Drops blank lines and validates against the same limits the database enforces. */
export function checkDraft(draft: RecipeDraft): DraftCheck {
  const candidate = {
    title: draft.title,
    ...(draft.description?.trim() ? { description: draft.description } : {}),
    ...(draft.imageUrl ? { imageUrl: draft.imageUrl } : {}),
    ...(draft.servings !== undefined ? { servings: draft.servings } : {}),
    ...(draft.prepMin !== undefined ? { prepMin: draft.prepMin } : {}),
    ...(draft.cookMin !== undefined ? { cookMin: draft.cookMin } : {}),
    ingredients: draft.ingredients
      .filter((line) => line.rawText.trim().length > 0)
      .map((line) => ({
        rawText: line.rawText,
        ...(line.groupName?.trim() ? { groupName: line.groupName } : {}),
      })),
    instructions: draft.instructions.filter((step) => step.trim().length > 0),
    ...(draft.nutrition ? { nutrition: draft.nutrition } : {}),
    ...(draft.tags && draft.tags.length > 0 ? { tags: draft.tags } : {}),
    ...(draft.cuisine?.trim() ? { cuisine: draft.cuisine } : {}),
  };
  const parsed = NormalizedRecipe.safeParse(candidate);
  if (parsed.success) return { ok: true, recipe: parsed.data };
  const issue = parsed.error.issues[0];
  return {
    ok: false,
    field: String(issue?.path[0] ?? "recipe"),
    message: issue?.message ?? "invalid",
  };
}

// ---------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------

/**
 * What identifies "the same recipe" in a household: the link it came from, or, when it has none,
 * its title with case and spacing folded. The keys come from `@mp/recipe-import/dedupe`
 * (`normalizeSourceUrl`, `normalizeTitle`, `titleSearchPattern`), the same functions the
 * recipe-import Edge Function uses. This package takes them as arguments so it stays free of the
 * importers.
 */
export interface DuplicateCheck {
  /** `normalizeSourceUrl(link)`. When set, only the link is compared. */
  sourceUrlNormalized?: string | null | undefined;
  /** Used when there is no link. `pattern` is an ilike prefilter, `isSame` the exact test. */
  title?: { pattern: string; isSame: (candidate: string) => boolean } | undefined;
}

/**
 * A live recipe of the household that matches `check`, or null. Reads as the caller, so row level
 * security keeps this to the household's own recipes.
 */
export async function findDuplicateRecipe(
  client: MpClient,
  householdId: string,
  check: DuplicateCheck,
): Promise<{ recipeId: string; matchedBy: DuplicateMatch } | null> {
  if (check.sourceUrlNormalized) {
    const found = await client
      .from("recipes")
      .select("id")
      .eq("household_id", householdId)
      .is("deleted_at", null)
      .eq("source_url_normalized", check.sourceUrlNormalized)
      .limit(1)
      .maybeSingle();
    if (found.error) throw new RecipeError("unknown", found.error.message);
    return found.data ? { recipeId: found.data.id, matchedBy: "url" } : null;
  }
  if (check.title) {
    const { pattern, isSame } = check.title;
    const found = await client
      .from("recipes")
      .select("id, title")
      .eq("household_id", householdId)
      .is("deleted_at", null)
      .ilike("title", pattern)
      .limit(25);
    if (found.error) throw new RecipeError("unknown", found.error.message);
    const match = (found.data ?? []).find((row) => isSame(row.title));
    return match ? { recipeId: match.id, matchedBy: "title" } : null;
  }
  return null;
}

export interface CreateRecipeArgs {
  householdId: string;
  draft: RecipeDraft;
  /** manual, photo (a confirmed photo import), video (a caption with a post link), or text. */
  sourceType: RecipeSourceType;
  /** Required for url and video. Shown as attribution. */
  sourceUrl?: string | undefined;
  /**
   * When set, a live recipe of the household that matches is a duplicate: the save throws
   * `RecipeError("duplicate")` carrying that recipe's id. `allowDuplicate` lets a same-title
   * recipe through. It never lets a same-link recipe through: the database allows one live recipe
   * per link in a household (recipes_household_source_url_normalized_uq).
   */
  duplicateCheck?: DuplicateCheck | undefined;
  allowDuplicate?: boolean | undefined;
}

/** The Postgres unique-violation code, and the index the database keeps on a recipe's link. */
const UNIQUE_VIOLATION = "23505";
const SOURCE_URL_INDEX = "recipes_household_source_url_normalized_uq";

/**
 * Saves a recipe the person typed in or confirmed from a draft. Ingredient lines keep their raw
 * text only; the parser (WS03) fills the rest (see `useCreateRecipe`). If the lines cannot be
 * saved, the new recipe is soft-deleted so no empty recipe is left in the list.
 */
export async function createRecipe(client: MpClient, args: CreateRecipeArgs): Promise<string> {
  const checked = checkDraft(args.draft);
  if (!checked.ok) throw new RecipeError("invalid", checked.message);
  const { recipe } = checked;

  const check = args.duplicateCheck;
  if (check && !(args.allowDuplicate && !check.sourceUrlNormalized)) {
    const existing = await findDuplicateRecipe(client, args.householdId, check);
    if (existing) throw new RecipeError("duplicate", undefined, existing);
  }

  const created = await client
    .from("recipes")
    .insert({
      household_id: args.householdId,
      title: recipe.title,
      description: recipe.description ?? null,
      image_url: recipe.imageUrl ?? null,
      source_type: args.sourceType,
      source_url: args.sourceUrl ?? null,
      servings: recipe.servings ?? null,
      prep_min: recipe.prepMin ?? null,
      cook_min: recipe.cookMin ?? null,
      instructions: instructionsToJson(recipe.instructions),
      nutrition: recipe.nutrition ?? null,
      tags: recipe.tags ?? [],
      cuisine: recipe.cuisine ?? null,
      visibility: "household",
    })
    .select("id")
    .single();
  if (created.error || !created.data) {
    // Two saves of the same link raced past the check above: the database's unique index is the
    // backstop, and the person gets the same answer as if the check had caught it.
    if (
      created.error?.code === UNIQUE_VIOLATION &&
      created.error.message.includes(SOURCE_URL_INDEX) &&
      args.sourceUrl
    ) {
      const key = await client.rpc("normalize_source_url", { raw: args.sourceUrl });
      const existing = key.data
        ? await findDuplicateRecipe(client, args.householdId, { sourceUrlNormalized: key.data })
        : null;
      if (existing) throw new RecipeError("duplicate", undefined, existing);
    }
    throw new RecipeError("unknown", created.error?.message);
  }
  const recipeId = created.data.id;

  const lines = await client.from("recipe_ingredients").insert(
    recipe.ingredients.map((line, position) => ({
      recipe_id: recipeId,
      position,
      group_name: line.groupName ?? null,
      raw_text: line.rawText,
    })),
  );
  if (lines.error) {
    await client
      .from("recipes")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", recipeId);
    throw new RecipeError("unknown", lines.error.message);
  }
  return recipeId;
}

/** What a line's rows have in common when the parser split one written line into several. */
function rowShape(row: { position: number; group_name: string | null; raw_text: string }): string {
  return `${row.position}\u0000${row.group_name ?? ""}\u0000${row.raw_text}`;
}

/**
 * Saves an edit. Lines the person did not touch keep their parsed fields. A line whose text
 * changed is saved with its parsed fields cleared, so parse-ingredients (WS03) reads it again.
 * Lines left out of the draft are deleted; lines without an id are added.
 *
 * Resolves with `needsParse`: true when a line was added or its text changed, so there is
 * something for parse-ingredients to read (see `useUpdateRecipe`).
 */
export async function updateRecipe(
  client: MpClient,
  recipeId: string,
  draft: RecipeDraft,
): Promise<{ needsParse: boolean }> {
  const checked = checkDraft(draft);
  if (!checked.ok) throw new RecipeError("invalid", checked.message);
  const { recipe } = checked;

  const updated = await client
    .from("recipes")
    .update({
      title: recipe.title,
      description: recipe.description ?? null,
      image_url: recipe.imageUrl ?? null,
      servings: recipe.servings ?? null,
      prep_min: recipe.prepMin ?? null,
      cook_min: recipe.cookMin ?? null,
      instructions: instructionsToJson(recipe.instructions),
      nutrition: recipe.nutrition ?? null,
      tags: recipe.tags ?? [],
      cuisine: recipe.cuisine ?? null,
    })
    .eq("id", recipeId)
    .is("deleted_at", null)
    .select("id");
  if (updated.error) throw new RecipeError("unknown", updated.error.message);
  if (!updated.data || updated.data.length === 0) throw new RecipeError("not_found");

  const existing = await client
    .from("recipe_ingredients")
    .select("id, raw_text, group_name, position")
    .eq("recipe_id", recipeId);
  if (existing.error) throw new RecipeError("unknown", existing.error.message);
  const before = new Map((existing.data ?? []).map((row) => [row.id, row]));

  // Index into the cleaned list, matching what checkDraft kept.
  const kept = draft.ingredients.filter((line) => line.rawText.trim().length > 0);
  const lines = kept.map((line, position) => ({
    line,
    text: recipe.ingredients[position],
    position,
  }));
  const keepIds = new Set(
    lines.flatMap(({ line }) => (line.id && before.has(line.id) ? [line.id] : [])),
  );

  // When the parser reads a line that names several ingredients ("salt and pepper to taste") it
  // adds a row for each extra one, with the line's position, heading and text. The edit form shows
  // such a line once, so the draft carries the first row only. The extras go with their line: they
  // stay (and move along) while its text is untouched, and are dropped when the text changes,
  // because the line is read again and may split differently.
  const keptByShape = new Map<string, string>();
  for (const id of keepIds) {
    const row = before.get(id);
    if (row && !keptByShape.has(rowShape(row))) keptByShape.set(rowShape(row), id);
  }
  const extrasOf = new Map<string, string[]>();
  for (const [id, row] of before) {
    const owner = keepIds.has(id) ? undefined : keptByShape.get(rowShape(row));
    if (owner) extrasOf.set(owner, [...(extrasOf.get(owner) ?? []), id]);
  }
  const textUnchanged = new Set(
    lines.flatMap(({ line, text }) => {
      const row = line.id ? before.get(line.id) : undefined;
      return row && text && row.raw_text === text.rawText ? [row.id] : [];
    }),
  );
  const staying = new Set(
    [...extrasOf].flatMap(([owner, ids]) => (textUnchanged.has(owner) ? ids : [])),
  );

  const removed = [...before.keys()].filter((id) => !keepIds.has(id) && !staying.has(id));
  if (removed.length > 0) {
    const result = await client.from("recipe_ingredients").delete().in("id", removed);
    if (result.error) throw new RecipeError("unknown", result.error.message);
  }

  let needsParse = false;
  for (const { line, text, position } of lines) {
    if (!text) continue;
    const current = line.id ? before.get(line.id) : undefined;
    if (current) {
      const textChanged = current.raw_text !== text.rawText;
      if (textChanged) needsParse = true;
      const groupChanged = (current.group_name ?? null) !== (text.groupName ?? null);
      const extras = textChanged ? [] : (extrasOf.get(current.id) ?? []);
      if (extras.length > 0 && (groupChanged || current.position !== position)) {
        const moved = await client
          .from("recipe_ingredients")
          .update({ position, group_name: text.groupName ?? null })
          .in("id", extras);
        if (moved.error) throw new RecipeError("unknown", moved.error.message);
      }
      if (!textChanged && !groupChanged && current.position === position) continue;
      const result = await client
        .from("recipe_ingredients")
        .update({
          position,
          group_name: text.groupName ?? null,
          raw_text: text.rawText,
          ...(textChanged
            ? {
                qty: null,
                qty_max: null,
                unit: null,
                ingredient_id: null,
                prep_note: null,
                optional: false,
                parse_confidence: null,
              }
            : {}),
        })
        .eq("id", current.id);
      if (result.error) throw new RecipeError("unknown", result.error.message);
    } else {
      const result = await client.from("recipe_ingredients").insert({
        recipe_id: recipeId,
        position,
        group_name: text.groupName ?? null,
        raw_text: text.rawText,
      });
      if (result.error) throw new RecipeError("unknown", result.error.message);
      needsParse = true;
    }
  }
  return { needsParse };
}

/** Soft delete: sets deleted_at, and the recipe leaves every list. Clients cannot hard-delete. */
export async function deleteRecipe(client: MpClient, recipeId: string): Promise<void> {
  const { data, error } = await client
    .from("recipes")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", recipeId)
    .is("deleted_at", null)
    .select("id");
  if (error) throw new RecipeError("unknown", error.message);
  if (!data || data.length === 0) throw new RecipeError("not_found");
}

/** Saves a typed or confirmed recipe, then matches its lines so it opens matched. */
export async function createRecipeAndMatch(
  client: MpClient,
  queryClient: QueryClient,
  args: CreateRecipeArgs,
): Promise<string> {
  const id = await createRecipe(client, args);
  await parseAfterWrite(client, queryClient, id);
  return id;
}

/** Saves an edit, then matches the lines the edit added or changed. */
export async function updateRecipeAndMatch(
  client: MpClient,
  queryClient: QueryClient,
  recipeId: string,
  draft: RecipeDraft,
): Promise<{ needsParse: boolean }> {
  const result = await updateRecipe(client, recipeId, draft);
  if (result.needsParse) await parseAfterWrite(client, queryClient, recipeId);
  return result;
}

export function useCreateRecipe() {
  const client = useSupabase();
  const queryClient = useQueryClient();
  return useMutation<string, RecipeError, CreateRecipeArgs>({
    mutationFn: (args) => createRecipeAndMatch(client, queryClient, args),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["recipes"] }),
  });
}

export function useUpdateRecipe(recipeId: string | null | undefined) {
  const client = useSupabase();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (draft: RecipeDraft) => {
      if (!recipeId) throw new RecipeError("not_found");
      return updateRecipeAndMatch(client, queryClient, recipeId, draft);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: recipeQueryKey(recipeId) });
      await queryClient.invalidateQueries({ queryKey: ["recipes"] });
    },
  });
}

export function useDeleteRecipe() {
  const client = useSupabase();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (recipeId: string) => deleteRecipe(client, recipeId),
    onSuccess: async (_data, recipeId) => {
      queryClient.removeQueries({ queryKey: recipeQueryKey(recipeId) });
      await queryClient.invalidateQueries({ queryKey: ["recipes"] });
    },
  });
}

// ---------------------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------------------

/** True for a path in the recipe-images bucket, false for an external http(s) link. */
export function isStorageImagePath(imageUrl: string | null | undefined): imageUrl is string {
  return Boolean(imageUrl) && !/^https?:\/\//i.test(imageUrl as string);
}

/** A short-lived signed URL for a path in the private bucket, or null. */
export async function getRecipeImageUrl(
  client: MpClient,
  path: string | null | undefined,
  expiresInSeconds = 3600,
): Promise<string | null> {
  if (!path) return null;
  const { data, error } = await client.storage
    .from(RECIPE_IMAGE_BUCKET)
    .createSignedUrl(path, expiresInSeconds);
  if (error) return null;
  return data.signedUrl;
}

/**
 * The URL to show for a recipe's image: an external link as is, a bucket path as a signed URL.
 * Signed URLs are never persisted: the query does not set `meta.persist`.
 */
export function useRecipeImageUrl(imageUrl: string | null | undefined): string | null {
  const client = useSupabase();
  const isPath = isStorageImagePath(imageUrl);
  const signed = useQuery({
    queryKey: ["recipe-image-url", imageUrl],
    enabled: isPath,
    staleTime: 50 * 60 * 1000,
    queryFn: () => getRecipeImageUrl(client, imageUrl),
  });
  if (!imageUrl) return null;
  return isPath ? (signed.data ?? null) : imageUrl;
}
