// Recipe schemas (WS02). Row shapes mirror supabase/migrations/*_recipes.sql, so `Recipe` and
// `RecipeIngredient` use the database's snake_case column names. `NormalizedRecipe` is the
// camelCase shape every importer produces and the edit form works on. docs/02-data-model.md
// §Recipes and docs/03-ai-design.md §4 are the references.
//
// No Node or DOM globals here (this package is pure), so URLs are checked with a pattern.
import { z } from "zod";

/** Timestamps as PostgREST returns them, for example 2026-10-30T07:12:14.123456+00:00. */
const Timestamp = z.iso.datetime({ offset: true });

export const RECIPE_SOURCE_TYPES = ["url", "text", "photo", "video", "manual", "ai"] as const;
export const RecipeSourceType = z.enum(RECIPE_SOURCE_TYPES);
export type RecipeSourceType = z.infer<typeof RecipeSourceType>;

export const RECIPE_VISIBILITIES = ["household", "catalog"] as const;
export const RecipeVisibility = z.enum(RECIPE_VISIBILITIES);
export type RecipeVisibility = z.infer<typeof RecipeVisibility>;

export const IMPORT_JOB_KINDS = ["url", "text", "photo", "caption"] as const;
export const ImportJobKind = z.enum(IMPORT_JOB_KINDS);
export type ImportJobKind = z.infer<typeof ImportJobKind>;

export const IMPORT_JOB_STATUSES = ["queued", "running", "done", "failed"] as const;
export const ImportJobStatus = z.enum(IMPORT_JOB_STATUSES);
export type ImportJobStatus = z.infer<typeof ImportJobStatus>;

/** Limits the database also enforces (CHECK constraints in the recipes migration). */
export const RECIPE_LIMITS = {
  title: 200,
  description: 4000,
  cuisine: 80,
  ingredientText: 500,
  groupName: 200,
  instructionText: 4000,
  ingredients: 200,
  instructions: 200,
  tags: 30,
  tagLength: 50,
  servingsMax: 1000,
  minutesMax: 20160,
  url: 2048,
} as const;

const HTTP_URL_PATTERN = /^https?:\/\/[^\s]+$/i;

/** An http or https URL. Anything else (javascript:, data:, file:) is rejected. */
export const HttpUrl = z
  .string()
  .trim()
  .max(RECIPE_LIMITS.url)
  .refine((value) => HTTP_URL_PATTERN.test(value), "must be an http or https URL");

/** The host of a recipe's source link without a leading "www.", for the attribution line. */
export function recipeSourceDomain(sourceUrl: string | null | undefined): string | null {
  if (!sourceUrl) return null;
  const match = /^https?:\/\/(?:[^/?#@]*@)?([^/:?#]+)/i.exec(sourceUrl.trim());
  const host = match?.[1]?.toLowerCase();
  return host ? host.replace(/^www\./, "") : null;
}

/**
 * An image reference: an http(s) URL, or a path in the recipe-images bucket (which has no URL
 * scheme). Any other scheme (javascript:, data:, file:) is rejected, as the database does.
 */
export const ImageRef = z
  .string()
  .trim()
  .min(1)
  .max(RECIPE_LIMITS.url)
  .refine(
    (value) => !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) || HTTP_URL_PATTERN.test(value),
    "must be an http or https URL or a storage path",
  );

// ---------------------------------------------------------------------------------------
// NormalizedRecipe: what every importer returns and the edit form works on
// ---------------------------------------------------------------------------------------

export const NormalizedIngredient = z.object({
  /** The line as the source wrote it. WS03 parses it later; WS02 stores it as is. */
  rawText: z.string().trim().min(1).max(RECIPE_LIMITS.ingredientText),
  /** A section heading such as "For the sauce". */
  groupName: z.string().trim().min(1).max(RECIPE_LIMITS.groupName).optional(),
});
export type NormalizedIngredient = z.infer<typeof NormalizedIngredient>;

export const NormalizedRecipe = z.object({
  title: z.string().trim().min(1).max(RECIPE_LIMITS.title),
  description: z.string().trim().min(1).max(RECIPE_LIMITS.description).optional(),
  /** An external http(s) URL or a path in the `recipe-images` bucket. */
  imageUrl: ImageRef.optional(),
  sourceUrl: HttpUrl.optional(),
  servings: z.number().positive().max(RECIPE_LIMITS.servingsMax).optional(),
  prepMin: z.number().int().min(0).max(RECIPE_LIMITS.minutesMax).optional(),
  cookMin: z.number().int().min(0).max(RECIPE_LIMITS.minutesMax).optional(),
  ingredients: z.array(NormalizedIngredient).min(1).max(RECIPE_LIMITS.ingredients),
  /** One string per step, in order. */
  instructions: z
    .array(z.string().trim().min(1).max(RECIPE_LIMITS.instructionText))
    .max(RECIPE_LIMITS.instructions),
  /** Per serving, as the source gave it ("calories": "320 kcal"). Display only. */
  nutrition: z.record(z.string(), z.string()).optional(),
  tags: z
    .array(z.string().trim().min(1).max(RECIPE_LIMITS.tagLength))
    .max(RECIPE_LIMITS.tags)
    .optional(),
  cuisine: z.string().trim().min(1).max(RECIPE_LIMITS.cuisine).optional(),
});
export type NormalizedRecipe = z.infer<typeof NormalizedRecipe>;

// ---------------------------------------------------------------------------------------
// Database rows
// ---------------------------------------------------------------------------------------

/** One element of recipes.instructions. */
export const RecipeInstruction = z.object({
  step: z.number().int().positive(),
  text: z.string().min(1).max(RECIPE_LIMITS.instructionText),
  group: z.string().max(RECIPE_LIMITS.groupName).optional(),
});
export type RecipeInstruction = z.infer<typeof RecipeInstruction>;

/** recipes.instructions: `{step, text, group?}[]`. */
export const RecipeInstructions = z.array(RecipeInstruction);

/**
 * A row of public.recipes as the client reads it. The `embedding` column is left out on
 * purpose: only the service role and WS06 touch it, and it is large.
 */
export const Recipe = z.object({
  id: z.uuid(),
  household_id: z.uuid().nullable(),
  title: z.string().min(1).max(RECIPE_LIMITS.title),
  description: z.string().nullable(),
  image_url: z.string().nullable(),
  source_type: RecipeSourceType,
  source_url: z.string().nullable(),
  servings: z.number().nullable(),
  prep_min: z.number().int().nullable(),
  cook_min: z.number().int().nullable(),
  instructions: RecipeInstructions,
  nutrition: z.record(z.string(), z.string()).nullable(),
  tags: z.array(z.string()),
  cuisine: z.string().nullable(),
  visibility: RecipeVisibility,
  created_by: z.uuid().nullable(),
  created_at: Timestamp,
  updated_at: Timestamp,
  deleted_at: Timestamp.nullable(),
});
export type Recipe = z.infer<typeof Recipe>;

/** A row of public.recipe_ingredients. WS03 fills every column except id, recipe_id, position, group_name, raw_text. */
export const RecipeIngredient = z.object({
  id: z.uuid(),
  recipe_id: z.uuid(),
  position: z.number().int().min(0),
  group_name: z.string().nullable(),
  raw_text: z.string().min(1).max(RECIPE_LIMITS.ingredientText),
  /** Lower bound when the line gives a range. */
  qty: z.number().nullable(),
  /** Upper bound of a range. */
  qty_max: z.number().nullable(),
  unit: z.string().nullable(),
  ingredient_id: z.uuid().nullable(),
  prep_note: z.string().nullable(),
  optional: z.boolean(),
  parse_confidence: z.number().min(0).max(1).nullable(),
});
export type RecipeIngredient = z.infer<typeof RecipeIngredient>;

/** A recipe with its ingredient lines in order, as the detail and edit screens read it. */
export const RecipeWithIngredients = Recipe.extend({
  ingredients: z.array(RecipeIngredient),
});
export type RecipeWithIngredients = z.infer<typeof RecipeWithIngredients>;

// ---------------------------------------------------------------------------------------
// Mapping between NormalizedRecipe and database columns
// ---------------------------------------------------------------------------------------

/** The `instructions` jsonb for a list of steps. */
export function instructionsToJson(steps: readonly string[]): RecipeInstruction[] {
  return steps.map((text, i) => ({ step: i + 1, text }));
}

/** The steps of a recipe in order, as plain strings. */
export function instructionsToSteps(instructions: readonly RecipeInstruction[]): string[] {
  return [...instructions].sort((a, b) => a.step - b.step).map((i) => i.text);
}

// ---------------------------------------------------------------------------------------
// The recipe-import Edge Function contract (supabase/functions/recipe-import/README.md)
// ---------------------------------------------------------------------------------------

export const IMPORT_REQUEST_KINDS = ["url", "text", "image", "caption"] as const;
export const ImportRequestKind = z.enum(IMPORT_REQUEST_KINDS);
export type ImportRequestKind = z.infer<typeof ImportRequestKind>;

export const IMPORT_LIMITS = {
  /** Characters of pasted text or a caption. */
  textMax: 30_000,
  captionMax: 10_000,
  textMin: 20,
  /** Path inside the recipe-images bucket. */
  pathMax: 300,
} as const;

const ImportBase = {
  /** Defaults to the caller's most recently joined household. The caller must be a member. */
  householdId: z.uuid().optional(),
  /**
   * true (the default for url and text): write the recipe and return its id.
   * false (what the app sends for photo and caption): return the draft and write no recipe, so the
   * person can edit and confirm before saving.
   */
  save: z.boolean().optional(),
};

export const ImportRecipeRequest = z.discriminatedUnion("kind", [
  z.object({ ...ImportBase, kind: z.literal("url"), input: HttpUrl }),
  z.object({
    ...ImportBase,
    kind: z.literal("text"),
    input: z.string().trim().min(IMPORT_LIMITS.textMin).max(IMPORT_LIMITS.textMax),
  }),
  z.object({
    ...ImportBase,
    kind: z.literal("image"),
    /** `{ path }` is an object in the household's folder of the recipe-images bucket. */
    input: z.object({ path: z.string().trim().min(3).max(IMPORT_LIMITS.pathMax) }),
  }),
  z.object({
    ...ImportBase,
    kind: z.literal("caption"),
    input: z.string().trim().min(1).max(IMPORT_LIMITS.captionMax),
    /** The shared post's link. Stored as the recipe's source_url (attribution). */
    sourceUrl: HttpUrl.optional(),
  }),
]);
export type ImportRecipeRequest = z.infer<typeof ImportRecipeRequest>;

/** Which stage produced the recipe. `jsonld` and `scraper` are deterministic; the rest use a model. */
export const IMPORT_PATHS = ["jsonld", "scraper", "llm", "text", "vision", "caption"] as const;
export const ImportPath = z.enum(IMPORT_PATHS);
export type ImportPath = z.infer<typeof ImportPath>;

export const IMPORT_ERROR_CODES = [
  "unauthorized",
  "invalid_request",
  "no_household",
  "not_a_member",
  "video_platform",
  "blocked",
  "fetch_failed",
  "not_html",
  "too_large",
  "no_recipe_found",
  "not_enough_text",
  "model_unavailable",
  "model_failed",
  "cost_cap",
  "rate_limited",
  "image_not_found",
  "save_failed",
  "internal_error",
] as const;
export const ImportErrorCode = z.enum(IMPORT_ERROR_CODES);
export type ImportErrorCode = z.infer<typeof ImportErrorCode>;

export const ImportRecipeSuccess = z.object({
  ok: z.literal(true),
  jobId: z.uuid(),
  path: ImportPath,
  /** Set when the recipe was saved. */
  recipeId: z.uuid().optional(),
  /** Set when `save` was false: the recipe to review. */
  draft: NormalizedRecipe.optional(),
  /** Short codes the UI may explain, for example `no_instructions`. */
  warnings: z.array(z.string()),
});

export type ImportRecipeSuccess = z.infer<typeof ImportRecipeSuccess>;

export const ImportRecipeFailure = z.object({
  ok: z.literal(false),
  error: ImportErrorCode,
  message: z.string().optional(),
  jobId: z.uuid().optional(),
});

export type ImportRecipeFailure = z.infer<typeof ImportRecipeFailure>;

export const ImportRecipeResponse = z.discriminatedUnion("ok", [
  ImportRecipeSuccess,
  ImportRecipeFailure,
]);
export type ImportRecipeResponse = z.infer<typeof ImportRecipeResponse>;

/** Short text for each failure, written for the person using the app. */
export const IMPORT_ERROR_MESSAGES: Record<ImportErrorCode, string> = {
  unauthorized: "Your session has ended. Sign in again.",
  invalid_request: "That does not look like something we can import.",
  no_household: "Create or join a household before adding recipes.",
  not_a_member: "You are not a member of that household.",
  video_platform:
    "We do not download videos. Share the post into the app to import its caption, or paste the recipe text.",
  blocked:
    "That site would not let us read the page. Paste the recipe text or take a photo instead.",
  fetch_failed: "We could not load that page. Check the link or paste the recipe text.",
  not_html: "That link is not a web page.",
  too_large: "That page or image is too large to import.",
  no_recipe_found:
    "We could not find a recipe on that page. Paste the text or take a photo instead.",
  not_enough_text:
    "There is not enough text in the caption to make a recipe. Paste the recipe or take a photo.",
  model_unavailable: "Recipe reading is not available right now. Try again later.",
  model_failed: "We could not read that recipe. Try pasting the text instead.",
  cost_cap: "You have reached today's limit for reading recipes. Try again tomorrow.",
  rate_limited: "You are importing too fast. Wait a few minutes and try again.",
  image_not_found: "We could not find that photo. Take it again.",
  save_failed: "We read the recipe but could not save it. Try again.",
  internal_error: "Something went wrong. Try again.",
};
