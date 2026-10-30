// Database and Storage access for the recipe-import function (WS02).
//
// Two kinds of client, on purpose:
//   * the caller's (anon key plus their JWT): everything that writes the household's own data
//     (recipes, recipe_ingredients) or reads their Storage, so Row Level Security is the last
//     line of defence even if this function's own checks had a bug;
//   * the service role: import_jobs and ai_runs, which clients cannot write, and the cleanup of a
//     half-saved recipe. Every service-role query filters by household_id explicitly
//     (docs/05-security-privacy.md §Access control).

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type ImportJobKind,
  instructionsToJson,
  type NormalizedRecipe,
  type RecipeSourceType,
} from "../../../packages/core/src/index.ts";

export type HouseholdLookup =
  | { kind: "ok"; householdId: string }
  | { kind: "none" }
  | { kind: "not_member" };

export interface NewJob {
  householdId: string;
  kind: ImportJobKind;
  /** Small on purpose: the URL, the image path, or the length of pasted text. */
  input: Record<string, unknown>;
}

export interface JobUpdate {
  status: "done" | "failed";
  resultRecipeId?: string | null;
  error?: string | null;
}

export interface SaveRecipeInput {
  householdId: string;
  recipe: NormalizedRecipe;
  sourceType: RecipeSourceType;
  /** Overrides recipe.imageUrl (a photo import stores its Storage path). */
  imageUrl?: string | undefined;
  /** Overrides recipe.sourceUrl. */
  sourceUrl?: string | undefined;
}

export interface DownloadedImage {
  bytes: Uint8Array;
  contentType: string;
}

export interface ImportStore {
  resolveHousehold(
    authHeader: string,
    userId: string,
    requested: string | undefined,
  ): Promise<HouseholdLookup>;
  /** Import jobs the household created at or after `sinceIso`. */
  recentJobCount(householdId: string, sinceIso: string): Promise<number>;
  createJob(job: NewJob): Promise<string>;
  finishJob(jobId: string, householdId: string, update: JobUpdate): Promise<void>;
  /** Inserts the recipe and its ingredient lines as the caller. Returns the recipe id. */
  saveRecipe(authHeader: string, input: SaveRecipeInput): Promise<string>;
  /** Reads an object from the recipe-images bucket as the caller. Null when it cannot be read. */
  downloadImage(authHeader: string, path: string): Promise<DownloadedImage | null>;
  /** Model spend recorded in ai_runs for the household since `sinceIso`, in USD. */
  spentSince(householdId: string, sinceIso: string): Promise<number>;
}

export class SupabaseImportStore implements ImportStore {
  constructor(
    private readonly serviceDb: SupabaseClient,
    private readonly userClient: (authHeader: string) => SupabaseClient,
  ) {}

  async resolveHousehold(
    authHeader: string,
    userId: string,
    requested: string | undefined,
  ): Promise<HouseholdLookup> {
    let query = this.userClient(authHeader)
      .from("household_members")
      .select("household_id, created_at, households!inner(deleted_at)")
      .eq("user_id", userId)
      .is("households.deleted_at", null)
      .order("created_at", { ascending: false });
    if (requested) query = query.eq("household_id", requested);
    const { data, error } = await query.limit(1);
    if (error) throw new Error(`household lookup failed: ${error.message}`);
    const row = data?.[0] as { household_id: string } | undefined;
    if (row) return { kind: "ok", householdId: row.household_id };
    return requested ? { kind: "not_member" } : { kind: "none" };
  }

  async recentJobCount(householdId: string, sinceIso: string): Promise<number> {
    const { count, error } = await this.serviceDb
      .from("import_jobs")
      .select("id", { count: "exact", head: true })
      .eq("household_id", householdId)
      .gte("created_at", sinceIso);
    if (error) throw new Error(`import_jobs count failed: ${error.message}`);
    return count ?? 0;
  }

  async createJob(job: NewJob): Promise<string> {
    const { data, error } = await this.serviceDb
      .from("import_jobs")
      .insert({
        household_id: job.householdId,
        kind: job.kind,
        input: job.input,
        status: "running",
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`import_jobs insert failed: ${error?.message ?? "no row"}`);
    return (data as { id: string }).id;
  }

  async finishJob(jobId: string, householdId: string, update: JobUpdate): Promise<void> {
    const { error } = await this.serviceDb
      .from("import_jobs")
      .update({
        status: update.status,
        result_recipe_id: update.resultRecipeId ?? null,
        // The message is for the app's own use; keep the row small and free of page content.
        error: update.error ? update.error.slice(0, 300) : null,
        finished_at: new Date().toISOString(),
      })
      .eq("id", jobId)
      .eq("household_id", householdId);
    if (error) throw new Error(`import_jobs update failed: ${error.message}`);
  }

  async saveRecipe(authHeader: string, input: SaveRecipeInput): Promise<string> {
    const db = this.userClient(authHeader);
    const { recipe } = input;
    const { data, error } = await db
      .from("recipes")
      .insert({
        household_id: input.householdId,
        title: recipe.title,
        description: recipe.description ?? null,
        image_url: input.imageUrl ?? recipe.imageUrl ?? null,
        source_type: input.sourceType,
        source_url: input.sourceUrl ?? recipe.sourceUrl ?? null,
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
    if (error || !data) throw new Error(`recipes insert failed: ${error?.message ?? "no row"}`);
    const recipeId = (data as { id: string }).id;

    const lines = recipe.ingredients.map((line, position) => ({
      recipe_id: recipeId,
      position,
      group_name: line.groupName ?? null,
      raw_text: line.rawText,
      // qty, unit, and ingredient_id stay null: the parser (WS03) fills them.
    }));
    const inserted = await db.from("recipe_ingredients").insert(lines);
    if (inserted.error) {
      // No recipe without its ingredients. The caller cannot hard-delete, so the service role
      // removes the half-saved row, scoped to this household.
      await this.serviceDb
        .from("recipes")
        .delete()
        .eq("id", recipeId)
        .eq("household_id", input.householdId);
      throw new Error(`recipe_ingredients insert failed: ${inserted.error.message}`);
    }
    return recipeId;
  }

  async downloadImage(authHeader: string, path: string): Promise<DownloadedImage | null> {
    const { data, error } = await this.userClient(authHeader)
      .storage.from("recipe-images")
      .download(path);
    if (error || !data) return null;
    return {
      bytes: new Uint8Array(await data.arrayBuffer()),
      contentType: data.type || "application/octet-stream",
    };
  }

  async spentSince(householdId: string, sinceIso: string): Promise<number> {
    const { data, error } = await this.serviceDb
      .from("ai_runs")
      .select("cost_usd")
      .eq("household_id", householdId)
      .gte("created_at", sinceIso)
      .limit(5000);
    if (error) throw new Error(`ai_runs read failed: ${error.message}`);
    return (data ?? []).reduce(
      (sum, row) => sum + Number((row as { cost_usd: unknown }).cost_usd),
      0,
    );
  }
}
