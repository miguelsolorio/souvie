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

/** What makes two recipes "the same" to a household (packages/recipe-import/src/dedupe.ts). */
export interface DuplicateCheck {
  /** `normalizeSourceUrl(link)`. When set, only the link is compared. */
  sourceUrlNormalized?: string | undefined;
  /** Used when there is no link. `pattern` is an ilike prefilter, `isSame` the exact test. */
  title?: { pattern: string; isSame: (candidate: string) => boolean } | undefined;
}

export interface ExistingRecipe {
  recipeId: string;
  /** How it was recognised. A same-link match cannot be overridden: the database allows one live recipe per link. */
  matchedBy: "url" | "title";
}

/**
 * The database refused the recipe because the household already has a live one with the same
 * link (the unique index recipes_household_source_url_normalized_uq). Two imports raced past the
 * lookup; the handler answers as if the lookup had found it.
 */
export class DuplicateSaveError extends Error {
  constructor() {
    super("a recipe with this link already exists in the household");
    this.name = "DuplicateSaveError";
  }
}

const UNIQUE_VIOLATION = "23505";
const SOURCE_URL_INDEX = "recipes_household_source_url_normalized_uq";

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
  /**
   * A live recipe of the household that matches `check`, read as the caller, or null. Throws on a
   * database error; the handler decides whether to carry on without the answer.
   */
  findDuplicate(
    authHeader: string,
    householdId: string,
    check: DuplicateCheck,
  ): Promise<ExistingRecipe | null>;
  /**
   * Inserts the recipe and its ingredient lines as the caller. Returns the recipe id. Throws
   * `DuplicateSaveError` when the household already has a live recipe with the same link.
   */
  saveRecipe(authHeader: string, input: SaveRecipeInput): Promise<string>;
  /** Reads an object from the recipe-images bucket as the caller. Null when it cannot be read. */
  downloadImage(authHeader: string, path: string): Promise<DownloadedImage | null>;
  /** Model spend recorded in ai_runs for the household since `sinceIso`, in USD. */
  spentSince(householdId: string, sinceIso: string): Promise<number>;
  /** households.ai_daily_cap_usd; null when unknown, so the AI_DAILY_CAP_USD fallback applies. */
  householdCapUsd?(householdId: string): Promise<number | null>;
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

  async findDuplicate(
    authHeader: string,
    householdId: string,
    check: DuplicateCheck,
  ): Promise<ExistingRecipe | null> {
    const db = this.userClient(authHeader);
    if (check.sourceUrlNormalized) {
      const { data, error } = await db
        .from("recipes")
        .select("id")
        .eq("household_id", householdId)
        .is("deleted_at", null)
        .eq("source_url_normalized", check.sourceUrlNormalized)
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`recipes duplicate lookup failed: ${error.message}`);
      return data ? { recipeId: (data as { id: string }).id, matchedBy: "url" } : null;
    }
    if (check.title) {
      const { data, error } = await db
        .from("recipes")
        .select("id, title")
        .eq("household_id", householdId)
        .is("deleted_at", null)
        .ilike("title", check.title.pattern)
        .limit(25);
      if (error) throw new Error(`recipes duplicate lookup failed: ${error.message}`);
      const rows = (data ?? []) as Array<{ id: string; title: string }>;
      const match = rows.find((row) => check.title?.isSame(row.title));
      return match ? { recipeId: match.id, matchedBy: "title" } : null;
    }
    return null;
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
    if (error?.code === UNIQUE_VIOLATION && error.message.includes(SOURCE_URL_INDEX)) {
      throw new DuplicateSaveError();
    }
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

  /** Summed in SQL (WS08's household_ai_spend_since), so PostgREST's row limit cannot undercount. */
  async spentSince(householdId: string, sinceIso: string): Promise<number> {
    const { data, error } = await this.serviceDb.rpc("household_ai_spend_since", {
      p_household_id: householdId,
      p_since: sinceIso,
    });
    if (error) throw new Error(`household_ai_spend_since failed: ${error.message}`);
    const spent = Number(data);
    return Number.isFinite(spent) ? spent : 0;
  }

  /** The household's own daily cap (WS15), or null when the row or the column is not there. */
  async householdCapUsd(householdId: string): Promise<number | null> {
    const { data, error } = await this.serviceDb
      .from("households")
      .select("ai_daily_cap_usd")
      .eq("id", householdId)
      .maybeSingle();
    if (error) throw new Error(`households read failed: ${error.message}`);
    const cap = Number((data as { ai_daily_cap_usd?: unknown } | null)?.ai_daily_cap_usd);
    return Number.isFinite(cap) ? cap : null;
  }
}
