// Typed calls, query keys, cache edits, and errors for the grocery list and the pantry (WS05). The
// hooks in ./hooks/useGroceryList*.ts, useToggleItem.ts, useAddManualItem.ts, usePantry.ts and
// useBuildList.ts are thin wrappers over this file, so the interesting logic is testable without
// rendering React.
//
// How a write reaches the database, and why it looks like this:
//   * A check-off is an UPDATE of checked, checked_by and checked_at to an explicit state, stamped
//     with the time of the tap. The same update twice changes nothing more, and an older stamp
//     never overwrites a newer one (the check guard trigger, supabase/migrations/*_lists.sql), so
//     a queue that replays hours later after a reconnect can neither duplicate nor clobber.
//   * A manual item is `INSERT ... ON CONFLICT (id) DO NOTHING` with an id the phone picked, so a
//     retry after a dropped connection never makes a duplicate.
//   * Edits send only the columns that changed, and an edit of the amount, unit or section also
//     sets `edited`, which tells a rebuild to keep it.
//   * Clients cannot create a list or write the automatic columns: `list-build` does that.
import {
  type GroceryList,
  GroceryListItem,
  ItemDetail,
  ItemPatch,
  type ListBuildFailure,
  type ListBuildRequest,
  type ListBuildResponse,
  ManualItemInput,
  type PantryItem,
  type PantryStatus,
  planFingerprint,
} from "@mp/core";
import type { QueryClient } from "@tanstack/react-query";
import type { MpClient } from "./client";

// ---------------------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------------------
// ['grocery-list', householdId, listId] is the contract in the WS05 brief. The household is in
// every key, so a persisted cache never shows one household's list to another. The list found by
// its plan and the list's items sit under the same prefix, so one invalidation of
// ['grocery-list', householdId] (the Realtime handler does this) refreshes all of it.

export const groceryListRootKey = (householdId: string | null | undefined) =>
  ["grocery-list", householdId] as const;

export const groceryListKey = (
  householdId: string | null | undefined,
  listId: string | null | undefined,
) => ["grocery-list", householdId, listId] as const;

export const groceryListByPlanKey = (
  householdId: string | null | undefined,
  planId: string | null | undefined,
) => ["grocery-list", householdId, "plan", planId] as const;

export const groceryItemsKey = (
  householdId: string | null | undefined,
  listId: string | null | undefined,
) => ["grocery-list", householdId, listId, "items"] as const;

export const pantryKey = (householdId: string | null | undefined) =>
  ["pantry", householdId] as const;

export const stapleIngredientsKey = () => ["ingredients", "staples"] as const;

export const ingredientSearchKey = (term: string) => ["ingredients", "search", term] as const;

// ---------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------

export type ListErrorCode =
  | "network"
  | "forbidden"
  | "not_found"
  | "invalid"
  | "no_plan"
  | "conflict"
  | "unknown";

export class ListError extends Error {
  readonly code: ListErrorCode;

  constructor(code: ListErrorCode, message?: string) {
    super(message ?? code);
    this.name = "ListError";
    this.code = code;
  }
}

export const LIST_ERROR_MESSAGES: Record<ListErrorCode, string> = {
  network: "You are offline or the connection dropped. Your changes are kept and will sync.",
  forbidden: "You can't change that list.",
  not_found: "That item is gone. Pull to refresh.",
  invalid: "That change isn't valid. Check the amount and the name.",
  no_plan: "Nothing is planned for that week yet.",
  conflict: "Someone else just changed that. Pull to refresh.",
  unknown: "Something went wrong. Try again.",
};

export function listErrorMessage(error: unknown): string {
  if (error instanceof ListError) return LIST_ERROR_MESSAGES[error.code];
  return LIST_ERROR_MESSAGES.unknown;
}

const NETWORK_MESSAGE = /network|fetch|timeout|timed out|offline|abort|connection|econn|enotfound/i;

/**
 * Maps a PostgREST failure to a ListError. `status` is the HTTP status of the response: 0 means
 * the request never got one (offline, DNS, a dropped socket). The triggers raise plain codes in
 * the message (list_not_found, checked_by_mismatch).
 */
export function toListError(
  failure: { message?: string | null; code?: string | null },
  status?: number,
): ListError {
  const message = (failure.message ?? "").trim();
  const code = failure.code ?? "";
  if (status === 0 || (status === undefined && !code && NETWORK_MESSAGE.test(message))) {
    return new ListError("network", message || "network error");
  }
  if (message === "list_not_found") return new ListError("not_found", message);
  if (message === "checked_by_mismatch" || code === "42501") {
    return new ListError("forbidden", message);
  }
  if (code === "23503") return new ListError("not_found", message);
  if (code === "23505") return new ListError("conflict", message);
  if (code === "23514" || code === "22P02" || code === "23502") {
    return new ListError("invalid", message);
  }
  if (status !== undefined && status >= 500) return new ListError("network", message);
  return new ListError("unknown", message || "unknown error");
}

// ---------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------

const LIST_COLUMNS =
  "id, household_id, plan_id, name, status, built_at, plan_version, plan_fingerprint, section_order, created_at, updated_at, deleted_at";
const ITEM_COLUMNS =
  "id, list_id, household_id, ingredient_id, display_name, qty, unit, source_entry_ids, section, checked, checked_by, checked_at, excluded_reason, needs_attention, is_manual, position, qualifiers, edited, detail, created_at, updated_at";

/** The live list for a plan, or null when it has not been built. */
export async function fetchListByPlan(
  client: MpClient,
  householdId: string,
  planId: string,
): Promise<GroceryList | null> {
  const { data, error, status } = await client
    .from("grocery_lists")
    .select(LIST_COLUMNS)
    .eq("household_id", householdId)
    .eq("plan_id", planId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw toListError(error, status);
  return data as GroceryList | null;
}

/** One list by id, or null when it is gone or belongs to another household. */
export async function fetchListById(
  client: MpClient,
  householdId: string,
  listId: string,
): Promise<GroceryList | null> {
  const { data, error, status } = await client
    .from("grocery_lists")
    .select(LIST_COLUMNS)
    .eq("household_id", householdId)
    .eq("id", listId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw toListError(error, status);
  return data as GroceryList | null;
}

/** The household's newest live list, for opening the app straight on it. */
export async function fetchLatestList(
  client: MpClient,
  householdId: string,
): Promise<GroceryList | null> {
  const { data, error, status } = await client
    .from("grocery_lists")
    .select(LIST_COLUMNS)
    .eq("household_id", householdId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw toListError(error, status);
  return ((data ?? [])[0] as GroceryList | undefined) ?? null;
}

/** The Monday of a plan's week, or null when the plan is gone. For rebuilding a list opened by id. */
export async function fetchPlanWeekStart(
  client: MpClient,
  householdId: string,
  planId: string,
): Promise<string | null> {
  const { data, error, status } = await client
    .from("meal_plans")
    .select("week_start")
    .eq("household_id", householdId)
    .eq("id", planId)
    .maybeSingle();
  if (error) throw toListError(error, status);
  return (data as { week_start: string } | null)?.week_start ?? null;
}

/** A list's items, in list order. */
export async function fetchListItems(client: MpClient, listId: string): Promise<GroceryListItem[]> {
  const { data, error, status } = await client
    .from("grocery_list_items")
    .select(ITEM_COLUMNS)
    .eq("list_id", listId)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw toListError(error, status);
  return sortItems((data ?? []).map(parseItemRow));
}

/**
 * A row as the server returns it, in the shape the screens read. The row goes through the
 * `GroceryListItem` schema, so `detail` of a manual item (the column default, `{}`) gains its empty
 * `contributions` and every list is a list. A row the strict schema refuses (a timestamp format
 * it does not know) is not dropped, since a missing item in the store is worse than an odd one:
 * its `detail`, `qualifiers` and `source_entry_ids` are repaired and the rest is kept as sent.
 */
export function parseItemRow(row: unknown): GroceryListItem {
  const parsed = GroceryListItem.safeParse(row);
  if (parsed.success) return parsed.data;
  const raw = (row ?? {}) as Record<string, unknown>;
  const detail = ItemDetail.safeParse(raw.detail ?? {});
  return {
    ...raw,
    detail: detail.success ? detail.data : { contributions: [] },
    qualifiers: Array.isArray(raw.qualifiers) ? raw.qualifiers : [],
    source_entry_ids: Array.isArray(raw.source_entry_ids) ? raw.source_entry_ids : [],
  } as GroceryListItem;
}

/** The household's pantry rows. A staple with no row is "have (default)", decided by the screen. */
export async function fetchPantry(client: MpClient, householdId: string): Promise<PantryItem[]> {
  const { data, error, status } = await client
    .from("pantry_items")
    .select("household_id, ingredient_id, status, updated_at")
    .eq("household_id", householdId);
  if (error) throw toListError(error, status);
  return (data ?? []) as PantryItem[];
}

/** The slice of an ingredient the pantry screen shows. */
export interface PantryIngredient {
  id: string;
  name: string;
  category: string;
  is_staple_default: boolean;
}

/** The ontology's staples: what counts as "have" until the household says otherwise. */
export async function fetchStapleIngredients(client: MpClient): Promise<PantryIngredient[]> {
  const { data, error, status } = await client
    .from("ingredients")
    .select("id, name, category, is_staple_default")
    .eq("is_staple_default", true)
    .order("name", { ascending: true })
    .limit(500);
  if (error) throw toListError(error, status);
  return (data ?? []) as PantryIngredient[];
}

/** Ingredients whose name contains `term`, for adding something to the pantry. */
export async function searchIngredients(
  client: MpClient,
  term: string,
  limit = 20,
): Promise<PantryIngredient[]> {
  const clean = term.trim().replace(/[%_,()\\]/g, " ");
  if (clean.length < 2) return [];
  const { data, error, status } = await client
    .from("ingredients")
    .select("id, name, category, is_staple_default")
    .ilike("name", `%${clean}%`)
    .order("name", { ascending: true })
    .limit(limit);
  if (error) throw toListError(error, status);
  return (data ?? []) as PantryIngredient[];
}

/** Ingredients by id, for naming pantry rows that are not staples. */
export async function fetchIngredientsById(
  client: MpClient,
  ids: readonly string[],
): Promise<PantryIngredient[]> {
  if (ids.length === 0) return [];
  const { data, error, status } = await client
    .from("ingredients")
    .select("id, name, category, is_staple_default")
    .in("id", [...ids]);
  if (error) throw toListError(error, status);
  return (data ?? []) as PantryIngredient[];
}

// ---------------------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------------------

/** Calls the list-build Edge Function. Throws ListError('no_plan') for a week nobody planned. */
export async function callListBuild(
  client: MpClient,
  request: ListBuildRequest,
): Promise<ListBuildResponse> {
  const { data, error } = await client.functions.invoke<ListBuildResponse | ListBuildFailure>(
    "list-build",
    { body: request },
  );
  if (error) {
    // A non-2xx response carries the body in error.context; try to read the reason from it.
    const response = (error as { context?: unknown }).context;
    if (response instanceof Response) {
      try {
        const body = (await response.clone().json()) as Partial<ListBuildFailure>;
        if (body.error === "no_plan") throw new ListError("no_plan", "no_plan");
        if (body.error === "not_a_member" || body.error === "unauthorized") {
          throw new ListError("forbidden", body.error);
        }
        if (body.error === "invalid_request") throw new ListError("invalid", body.error);
      } catch (inner) {
        if (inner instanceof ListError) throw inner;
      }
      throw new ListError(response.status >= 500 ? "network" : "unknown", error.message);
    }
    throw new ListError("network", error.message);
  }
  if (!data) throw new ListError("unknown", "list-build returned no body");
  if (data.ok === false) {
    if (data.error === "no_plan") throw new ListError("no_plan", "no_plan");
    throw new ListError(data.error === "internal_error" ? "unknown" : "forbidden", data.error);
  }
  return data;
}

// ---------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------

/**
 * Sets an item's check state to an explicit value stamped with `at`. Safe to repeat and safe to
 * replay late: the check guard trigger keeps the newer of two stamps. Resolves false when no row
 * matched (the item was removed by a rebuild or is not this household's).
 */
export async function writeItemChecked(
  client: MpClient,
  args: { itemId: string; checked: boolean; userId: string; at: string },
): Promise<boolean> {
  const { data, error, status } = await client
    .from("grocery_list_items")
    .update({ checked: args.checked, checked_by: args.userId, checked_at: args.at })
    .eq("id", args.itemId)
    .select("id");
  if (error) throw toListError(error, status);
  return (data ?? []).length > 0;
}

export interface NewManualItem {
  id: string;
  listId: string;
  householdId: string;
  item: ManualItemInput;
  position: number;
}

/** Inserts a manual item with an id the caller picked. Safe to repeat (ON CONFLICT DO NOTHING). */
export async function insertManualItem(client: MpClient, row: NewManualItem): Promise<void> {
  const item = ManualItemInput.parse(row.item);
  const { error, status } = await client.from("grocery_list_items").upsert(
    {
      id: row.id,
      list_id: row.listId,
      household_id: row.householdId,
      display_name: item.display_name,
      qty: item.qty,
      unit: item.unit,
      section: item.section,
      position: row.position,
      is_manual: true,
    },
    { onConflict: "id", ignoreDuplicates: true },
  );
  if (error) throw toListError(error, status);
}

/** Columns whose edit marks an item as edited, so a rebuild keeps the person's answer. */
export const EDIT_MARKING_COLUMNS = ["qty", "unit", "section"] as const;

/** The columns a patch writes: the patch itself, plus `edited` when it changes an amount. */
export function patchColumns(patch: ItemPatch): ItemPatch & { edited?: boolean } {
  const clean = ItemPatch.parse(patch);
  const marks = EDIT_MARKING_COLUMNS.some((column) => column in clean);
  return marks ? { ...clean, edited: true } : clean;
}

/** Updates only the given columns. Resolves false when no row matched. */
export async function patchItem(
  client: MpClient,
  itemId: string,
  patch: ItemPatch,
): Promise<boolean> {
  const columns = patchColumns(patch);
  if (Object.keys(columns).length === 0) return true;
  const { data, error, status } = await client
    .from("grocery_list_items")
    .update(columns)
    .eq("id", itemId)
    .select("id");
  if (error) throw toListError(error, status);
  return (data ?? []).length > 0;
}

/** Deletes a manual item. Already gone counts as done, so a retry cannot fail on its own success. */
export async function removeManualItem(client: MpClient, itemId: string): Promise<void> {
  const { error, status } = await client.from("grocery_list_items").delete().eq("id", itemId);
  if (error) throw toListError(error, status);
}

/** Renames a list, marks it shopped, or sets its aisle order. */
export async function patchList(
  client: MpClient,
  listId: string,
  patch: { name?: string; status?: GroceryList["status"]; section_order?: string[] | null },
): Promise<void> {
  const { error, status } = await client.from("grocery_lists").update(patch).eq("id", listId);
  if (error) throw toListError(error, status);
}

/**
 * Sets a pantry row's status, creating the row when the household has none. Two statements, because
 * a merge upsert cannot be used: PostgREST turns it into `ON CONFLICT DO UPDATE SET <every payload
 * column> = EXCLUDED.<column>`, which rewrites the key columns, and clients may update `status`
 * only (supabase/migrations/*_lists.sql). So: an insert that ignores a conflict (`ON CONFLICT DO
 * NOTHING`) creates the row if it is missing, then an update of `status` alone on the key sets it.
 * Both are safe to repeat, and the update is what makes a change of an existing row land.
 */
export async function writePantryStatus(
  client: MpClient,
  args: { householdId: string; ingredientId: string; status: PantryStatus },
): Promise<void> {
  const insert = await client
    .from("pantry_items")
    .upsert(
      { household_id: args.householdId, ingredient_id: args.ingredientId, status: args.status },
      { onConflict: "household_id,ingredient_id", ignoreDuplicates: true },
    );
  if (insert.error) throw toListError(insert.error, insert.status);
  const update = await client
    .from("pantry_items")
    .update({ status: args.status })
    .eq("household_id", args.householdId)
    .eq("ingredient_id", args.ingredientId);
  if (update.error) throw toListError(update.error, update.status);
}

/** Removes a pantry row, which returns the ingredient to its default (staples are "have"). */
export async function clearPantryStatus(
  client: MpClient,
  args: { householdId: string; ingredientId: string },
): Promise<void> {
  const { error, status } = await client
    .from("pantry_items")
    .delete()
    .eq("household_id", args.householdId)
    .eq("ingredient_id", args.ingredientId);
  if (error) throw toListError(error, status);
}

// ---------------------------------------------------------------------------------------
// Pure helpers and cache edits
// ---------------------------------------------------------------------------------------

/** Items in list order: position, then creation, then id, so the order is the same everywhere. */
export function sortItems<T extends Pick<GroceryListItem, "id" | "position" | "created_at">>(
  items: readonly T[],
): T[] {
  return [...items].sort(
    (a, b) =>
      a.position - b.position ||
      a.created_at.localeCompare(b.created_at) ||
      a.id.localeCompare(b.id),
  );
}

export function withItemChecked(
  items: readonly GroceryListItem[] | undefined,
  args: { itemId: string; checked: boolean; userId: string; at: string },
): GroceryListItem[] {
  return (items ?? []).map((item) =>
    item.id === args.itemId
      ? { ...item, checked: args.checked, checked_by: args.userId, checked_at: args.at }
      : item,
  );
}

export function withItemPatched(
  items: readonly GroceryListItem[] | undefined,
  itemId: string,
  patch: ItemPatch,
  now = new Date().toISOString(),
): GroceryListItem[] {
  const columns = patchColumns(patch);
  return (items ?? []).map((item) =>
    item.id === itemId ? { ...item, ...columns, updated_at: now } : item,
  );
}

export function withItemAdded(
  items: readonly GroceryListItem[] | undefined,
  item: GroceryListItem,
): GroceryListItem[] {
  return sortItems([...(items ?? []).filter((existing) => existing.id !== item.id), item]);
}

export function withoutItem(
  items: readonly GroceryListItem[] | undefined,
  itemId: string,
): GroceryListItem[] {
  return (items ?? []).filter((item) => item.id !== itemId);
}

/** The next position at the end of a list, for a manual item. */
export function nextItemPosition(items: readonly Pick<GroceryListItem, "position">[]): number {
  let max = -1;
  for (const item of items) if (item.position > max) max = item.position;
  return Math.min(max + 1, 1_000_000);
}

/** The row a manual item has before the server answers. */
export function manualItemRow(
  args: NewManualItem,
  now = new Date().toISOString(),
): GroceryListItem {
  const item = ManualItemInput.parse(args.item);
  return {
    id: args.id,
    list_id: args.listId,
    household_id: args.householdId,
    ingredient_id: null,
    display_name: item.display_name,
    qty: item.qty,
    unit: item.unit,
    source_entry_ids: [],
    section: item.section,
    checked: false,
    checked_by: null,
    checked_at: null,
    excluded_reason: null,
    needs_attention: false,
    is_manual: true,
    position: args.position,
    qualifiers: [],
    edited: false,
    detail: { contributions: [] },
    created_at: now,
    updated_at: now,
  };
}

/**
 * True when the plan changed after the list was built. The list stores a fingerprint of the plan's
 * entries (`planFingerprint`, the same function the server used); the app hashes the entries it
 * holds now. An ad-hoc list (no fingerprint) is never out of date.
 */
export function isListStale(
  list: Pick<GroceryList, "plan_fingerprint"> | null | undefined,
  entries: readonly { id: string; recipe_id: string; servings: number | string; status: string }[],
): boolean {
  if (!list?.plan_fingerprint) return false;
  return planFingerprint(entries) !== list.plan_fingerprint;
}

/** Marks every grocery-list query of a household stale. */
export function invalidateGroceryList(
  queryClient: QueryClient,
  householdId: string | null | undefined,
): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: groceryListRootKey(householdId) });
}
