import {
  instructionsToJson,
  NormalizedRecipe,
  type RecipeIngredient,
  RecipeInstructions,
  type RecipeSourceType,
  type RecipeWithIngredients,
} from "@mp/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MpClient } from "../client";
import { useSupabase } from "../context";

export const RECIPE_IMAGE_BUCKET = "recipe-images";

const RECIPE_COLUMNS =
  "id, household_id, title, description, image_url, source_type, source_url, servings, prep_min, cook_min, instructions, nutrition, tags, cuisine, visibility, created_by, created_at, updated_at, deleted_at";
const LINE_COLUMNS =
  "id, recipe_id, position, group_name, raw_text, qty, qty_max, unit, ingredient_id, prep_note, optional, parse_confidence";

export const recipeQueryKey = (id: string | null | undefined) => ["recipe", id] as const;

export type RecipeErrorCode = "not_found" | "invalid" | "unknown";

export class RecipeError extends Error {
  readonly code: RecipeErrorCode;

  constructor(code: RecipeErrorCode, message?: string) {
    super(message ?? code);
    this.name = "RecipeError";
    this.code = code;
  }
}

export const RECIPE_ERROR_MESSAGES: Record<RecipeErrorCode, string> = {
  not_found: "That recipe is gone or you cannot open it.",
  invalid: "Check the recipe: it needs a title and at least one ingredient.",
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

export interface CreateRecipeArgs {
  householdId: string;
  draft: RecipeDraft;
  /** manual, photo (a confirmed photo import), video (a caption with a post link), or text. */
  sourceType: RecipeSourceType;
  /** Required for url and video. Shown as attribution. */
  sourceUrl?: string | undefined;
}

/**
 * Saves a recipe the person typed in or confirmed from a draft. Ingredient lines keep their raw
 * text only; the parser (WS03) fills the rest. If the lines cannot be saved, the new recipe is
 * soft-deleted so no empty recipe is left in the list.
 */
export async function createRecipe(client: MpClient, args: CreateRecipeArgs): Promise<string> {
  const checked = checkDraft(args.draft);
  if (!checked.ok) throw new RecipeError("invalid", checked.message);
  const { recipe } = checked;

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

/**
 * Saves an edit. Lines the person did not touch keep their parsed fields. A line whose text
 * changed is saved with its parsed fields cleared, so parse-ingredients (WS03) reads it again.
 * Lines left out of the draft are deleted; lines without an id are added.
 */
export async function updateRecipe(
  client: MpClient,
  recipeId: string,
  draft: RecipeDraft,
): Promise<void> {
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

  const removed = [...before.keys()].filter((id) => !keepIds.has(id));
  if (removed.length > 0) {
    const result = await client.from("recipe_ingredients").delete().in("id", removed);
    if (result.error) throw new RecipeError("unknown", result.error.message);
  }

  for (const { line, text, position } of lines) {
    if (!text) continue;
    const current = line.id ? before.get(line.id) : undefined;
    if (current) {
      const textChanged = current.raw_text !== text.rawText;
      const groupChanged = (current.group_name ?? null) !== (text.groupName ?? null);
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
    }
  }
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

export function useCreateRecipe() {
  const client = useSupabase();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: CreateRecipeArgs) => createRecipe(client, args),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["recipes"] }),
  });
}

export function useUpdateRecipe(recipeId: string | null | undefined) {
  const client = useSupabase();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (draft: RecipeDraft) => {
      if (!recipeId) throw new RecipeError("not_found");
      return updateRecipe(client, recipeId, draft);
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
