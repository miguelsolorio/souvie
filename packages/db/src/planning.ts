// Typed calls, query keys, cache edits, and errors for the planner (WS04). The hooks in
// ./hooks/useMealPlan*.ts, useUpsertEntry.ts, useDeleteEntry.ts and useRecipeFeedback.ts are thin
// wrappers over this file, so the interesting logic is testable without rendering React.
//
// How a write reaches the database, and why it looks like this:
//   * A new entry is `INSERT ... ON CONFLICT (id) DO NOTHING` with an id the phone picked. A
//     retry after a dropped connection sends the same id and changes nothing, so there is never a
//     duplicate (acceptance criterion 6).
//   * An edit is an UPDATE of only the columns that changed. Clients hold column-level UPDATE
//     privileges (supabase/migrations/*_planning.sql), and sending only what changed keeps two
//     members' edits to different fields from overwriting each other.
//   * The saved, cooked, and skipped feedback rows are written by a database trigger in the same
//     transaction, so nothing here has to remember to write them.
import {
  type MealPlan,
  type MealPlanEntry,
  MealPlanEntryInput,
  MealPlanEntryPatch,
  sortEntries,
  weekStartFor,
} from "@mp/core";
import type { QueryClient } from "@tanstack/react-query";
import type { MpClient } from "./client";

// ---------------------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------------------

/** The slice of a recipe an entry shows. Embedded in the entries query, so one request is enough. */
export interface PlannedRecipe {
  id: string;
  title: string;
  /** An external URL or a path in the recipe-images bucket (see useRecipeImageUrl). */
  image_url: string | null;
  servings: number | null;
  prep_min: number | null;
  cook_min: number | null;
  /** Set when the recipe was deleted after it was planned. */
  deleted_at: string | null;
}

/** An entry plus its recipe. `recipe` is null when the recipe cannot be read (it left the household). */
export type PlanEntry = MealPlanEntry & { recipe: PlannedRecipe | null };

// ---------------------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------------------
// ['meal-plan', householdId, weekStart] is the contract with WS05 (docs/05-security-privacy and
// the brief): an entry change invalidates it, and the grocery list listens to it to offer "the
// list is out of date". Everything else about the plan lives under ['meal-plan', householdId], so
// one invalidation of that prefix (the Realtime handler does this) refreshes all of it. The
// household is in every key, so a persisted cache never shows one household's plan to another.

export const mealPlanRootKey = (householdId: string | null | undefined) =>
  ["meal-plan", householdId] as const;

export const mealPlanKey = (householdId: string | null | undefined, weekStart: string) =>
  ["meal-plan", householdId, weekStart] as const;

export const mealPlanEntriesKey = (
  householdId: string | null | undefined,
  planId: string | null | undefined,
) => ["meal-plan", householdId, "entries", planId] as const;

export const recentRecipesKey = (householdId: string | null | undefined) =>
  ["meal-plan", householdId, "recent-recipes"] as const;

export const recipeFeedbackKey = (
  userId: string | undefined,
  recipeId: string | null | undefined,
) => ["recipe-feedback", userId, recipeId] as const;

export const favoriteRecipesKey = (userId: string | undefined) =>
  ["recipe-feedback", userId, "favorites"] as const;

// ---------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------

export type PlanErrorCode =
  | "network"
  | "forbidden"
  | "not_found"
  | "invalid"
  | "conflict"
  | "unknown";

export class PlanError extends Error {
  readonly code: PlanErrorCode;

  constructor(code: PlanErrorCode, message?: string) {
    super(message ?? code);
    this.name = "PlanError";
    this.code = code;
  }
}

export const PLAN_ERROR_MESSAGES: Record<PlanErrorCode, string> = {
  network: "You are offline or the connection dropped. Check it and try again.",
  forbidden: "You can't change that plan.",
  not_found: "That meal or recipe is gone. Pull to refresh.",
  invalid: "That change isn't valid. Check the date, servings and notes.",
  conflict: "Someone else just changed that. Pull to refresh.",
  unknown: "Something went wrong. Try again.",
};

export function planErrorMessage(error: unknown): string {
  if (error instanceof PlanError) return PLAN_ERROR_MESSAGES[error.code];
  return PLAN_ERROR_MESSAGES.unknown;
}

const NETWORK_MESSAGE = /network|fetch|timeout|timed out|offline|abort|connection|econn|enotfound/i;
const NOT_FOUND_MESSAGES = ["plan_not_found", "recipe_not_found"];

/**
 * Maps a PostgREST failure to a PlanError. `status` is the HTTP status of the response: 0 means
 * the request never got one (offline, DNS, a dropped socket). The trigger raises plain codes in
 * the message (plan_not_found, date_outside_plan_week, recipe_not_found).
 */
export function toPlanError(
  failure: { message?: string | null; code?: string | null },
  status?: number,
): PlanError {
  const message = (failure.message ?? "").trim();
  const code = failure.code ?? "";
  if (status === 0 || (status === undefined && !code && NETWORK_MESSAGE.test(message))) {
    return new PlanError("network", message || "network error");
  }
  if (NOT_FOUND_MESSAGES.includes(message)) return new PlanError("not_found", message);
  if (message === "date_outside_plan_week") return new PlanError("invalid", message);
  if (code === "42501") return new PlanError("forbidden", message);
  if (code === "23503") return new PlanError("not_found", message);
  if (code === "23505") return new PlanError("conflict", message);
  if (code === "23514" || code === "22P02" || code === "23502") {
    return new PlanError("invalid", message);
  }
  if (status !== undefined && status >= 500) return new PlanError("network", message);
  return new PlanError("unknown", message || "unknown error");
}

/**
 * Every planner write from this device runs in this mutation scope, so TanStack runs them one
 * after another in the order they were made. Without it, three quick taps on the servings plus
 * button are three requests in flight at once, and the one that lands last on the server need not
 * be the last tap. The optimistic updates still apply at once; only the network calls queue.
 */
export const PLAN_WRITE_SCOPE = { id: "meal-plan-writes" } as const;

/** How many planner writes from this device have not finished (running, retrying, or queued). */
export function planWritesPending(queryClient: QueryClient): number {
  return queryClient.isMutating({
    predicate: (mutation) => mutation.options.scope?.id === PLAN_WRITE_SCOPE.id,
  });
}

/** Retry a write only while the connection is the problem, for about a minute of backoff. */
export function shouldRetryPlanWrite(failureCount: number, error: unknown): boolean {
  return error instanceof PlanError && error.code === "network" && failureCount < 6;
}

/** 1s, 2s, 4s, 8s, 16s, then 30s. */
export function planRetryDelay(failureCount: number): number {
  return Math.min(1000 * 2 ** failureCount, 30_000);
}

// ---------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------

const PLAN_COLUMNS = "id, household_id, week_start, created_at, updated_at";
const RECIPE_EMBED = "recipes(id, title, image_url, servings, prep_min, cook_min, deleted_at)";
const ENTRY_COLUMNS = `id, plan_id, household_id, date, slot, recipe_id, servings, status, notes, position, created_at, updated_at, why, ${RECIPE_EMBED}`;

type EntryRow = Omit<MealPlanEntry, "servings"> & {
  servings: number | string;
  recipes: PlannedRecipe | null;
};

function rowToEntry(row: EntryRow): PlanEntry {
  const { recipes, servings, ...entry } = row;
  return { ...entry, servings: Number(servings), recipe: recipes ?? null };
}

/** The household's plan for a week (any date in the week works), or null when none exists yet. */
export async function fetchMealPlan(
  client: MpClient,
  householdId: string,
  weekStart: string,
): Promise<MealPlan | null> {
  const { data, error, status } = await client
    .from("meal_plans")
    .select(PLAN_COLUMNS)
    .eq("household_id", householdId)
    .eq("week_start", weekStartFor(weekStart))
    .maybeSingle();
  if (error) throw toPlanError(error, status);
  return data as MealPlan | null;
}

/** A plan's entries with their recipes, ordered by day, then slot position. */
export async function fetchMealPlanEntries(client: MpClient, planId: string): Promise<PlanEntry[]> {
  const { data, error, status } = await client
    .from("meal_plan_entries")
    .select(ENTRY_COLUMNS)
    .eq("plan_id", planId)
    .order("date", { ascending: true })
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw toPlanError(error, status);
  return sortPlanEntries(((data ?? []) as unknown as EntryRow[]).map(rowToEntry));
}

/**
 * The recipes the household planned most recently, newest first, once each. For the picker's
 * Recent tab. Reads entries only; titles come from the recipes list.
 */
export async function fetchRecentRecipeIds(
  client: MpClient,
  householdId: string,
  limit = 12,
): Promise<string[]> {
  const { data, error, status } = await client
    .from("meal_plan_entries")
    .select("recipe_id, created_at")
    .eq("household_id", householdId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw toPlanError(error, status);
  return distinctRecipeIds((data ?? []) as Array<{ recipe_id: string }>, limit);
}

/** Recipe ids in first-seen order, each once. */
export function distinctRecipeIds(rows: ReadonlyArray<{ recipe_id: string }>, limit: number) {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.size >= limit) break;
    seen.add(row.recipe_id);
  }
  return [...seen];
}

export function sortPlanEntries(entries: readonly PlanEntry[]): PlanEntry[] {
  const order = new Map(sortEntries(entries).map((entry, index) => [entry.id, index]));
  return [...entries].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

// ---------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------

/**
 * Makes sure the household has a plan row for the week and returns it. The id is the caller's
 * suggestion: if another device created the week first, its row wins (ON CONFLICT DO NOTHING on
 * the unique week) and that id is returned instead.
 */
export async function ensureMealPlan(
  client: MpClient,
  args: { householdId: string; weekStart: string; planId: string },
): Promise<MealPlan> {
  const weekStart = weekStartFor(args.weekStart);
  const insert = await client
    .from("meal_plans")
    .upsert(
      { id: args.planId, household_id: args.householdId, week_start: weekStart },
      { onConflict: "household_id,week_start", ignoreDuplicates: true },
    );
  if (insert.error) throw toPlanError(insert.error, insert.status);
  const plan = await fetchMealPlan(client, args.householdId, weekStart);
  if (!plan) throw new PlanError("not_found", "plan_not_found");
  return plan;
}

export interface NewEntryRow {
  id: string;
  planId: string;
  householdId: string;
  entry: MealPlanEntryInput;
}

/**
 * Inserts an entry the caller already gave an id. Safe to repeat: a second attempt with the same
 * id changes nothing (ON CONFLICT DO NOTHING).
 */
export async function insertEntry(client: MpClient, row: NewEntryRow): Promise<void> {
  const entry = MealPlanEntryInput.parse(row.entry);
  const { error, status } = await client.from("meal_plan_entries").upsert(
    {
      id: row.id,
      plan_id: row.planId,
      household_id: row.householdId,
      date: entry.date,
      slot: entry.slot,
      recipe_id: entry.recipe_id,
      servings: entry.servings,
      status: entry.status,
      notes: entry.notes,
      position: entry.position,
      why: entry.why,
    },
    { onConflict: "id", ignoreDuplicates: true },
  );
  if (error) throw toPlanError(error, status);
}

/** Updates only the given columns. Throws not_found when the entry is gone. */
export async function patchEntry(
  client: MpClient,
  id: string,
  patch: MealPlanEntryPatch,
): Promise<void> {
  const clean = MealPlanEntryPatch.parse(patch);
  if (Object.keys(clean).length === 0) return;
  const { data, error, status } = await client
    .from("meal_plan_entries")
    .update(clean)
    .eq("id", id)
    .select("id");
  if (error) throw toPlanError(error, status);
  if (!data || data.length === 0) throw new PlanError("not_found", "entry_not_found");
}

/** Deletes an entry. Already gone counts as done, so a retry cannot fail on its own success. */
export async function removeEntry(client: MpClient, id: string): Promise<void> {
  const { error, status } = await client.from("meal_plan_entries").delete().eq("id", id);
  if (error) throw toPlanError(error, status);
}

// ---------------------------------------------------------------------------------------
// Cache edits (pure, so the optimistic updates are testable)
// ---------------------------------------------------------------------------------------

export function withEntry(entries: readonly PlanEntry[] | undefined, entry: PlanEntry) {
  const rest = (entries ?? []).filter((existing) => existing.id !== entry.id);
  return sortPlanEntries([...rest, entry]);
}

export function withoutEntry(entries: readonly PlanEntry[] | undefined, id: string) {
  return (entries ?? []).filter((entry) => entry.id !== id);
}

export function withPatch(
  entries: readonly PlanEntry[] | undefined,
  id: string,
  patch: MealPlanEntryPatch,
  now = new Date().toISOString(),
): PlanEntry[] {
  return sortPlanEntries(
    (entries ?? []).map((entry) =>
      entry.id === id ? { ...entry, ...patch, updated_at: now } : entry,
    ),
  );
}

/** The columns of `entry` that `patch` would overwrite, for putting them back on rollback. */
export function inversePatch(entry: PlanEntry, patch: MealPlanEntryPatch): MealPlanEntryPatch {
  const inverse: Record<string, unknown> = {};
  for (const key of Object.keys(patch) as Array<keyof MealPlanEntryPatch>) {
    inverse[key] = entry[key];
  }
  return inverse as MealPlanEntryPatch;
}

/** Every entry the query cache holds for this household, across weeks, to find one by id. */
export function findCachedEntry(
  queryClient: QueryClient,
  householdId: string,
  entryId: string,
): PlanEntry | undefined {
  const lists = queryClient.getQueriesData<PlanEntry[]>({
    queryKey: ["meal-plan", householdId, "entries"],
  });
  for (const [, entries] of lists) {
    const found = entries?.find((entry) => entry.id === entryId);
    if (found) return found;
  }
  return undefined;
}

/**
 * Marks the plan stale after an entry changed. The plan key is the one WS05 listens to; the
 * entries key refetches what the screen shows. Active queries refetch now, the rest on next use.
 * With no week (an edit whose entry the cache never held) every week of the household is marked.
 */
export async function invalidateMealPlan(
  queryClient: QueryClient,
  args: { householdId: string; weekStart?: string | null; planId?: string | null },
): Promise<void> {
  const tasks: Array<Promise<void>> = [
    queryClient.invalidateQueries({
      queryKey: args.weekStart
        ? mealPlanKey(args.householdId, args.weekStart)
        : mealPlanRootKey(args.householdId),
    }),
    queryClient.invalidateQueries({
      queryKey: args.planId
        ? mealPlanEntriesKey(args.householdId, args.planId)
        : ["meal-plan", args.householdId, "entries"],
    }),
    queryClient.invalidateQueries({ queryKey: recentRecipesKey(args.householdId) }),
  ];
  await Promise.all(tasks);
}
