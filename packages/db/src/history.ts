// Typed readers for the three History views, the pin write, and their query keys (WS12). The hooks
// in ./hooks/useHistory.ts are thin wrappers over this file.
//
// The views are security_invoker, so the caller's row level security decides every row; the
// household filter below narrows a query, it is not the security boundary.
//
//   v_meals_cooked_weekly     cooked meals per plan week (the plan's own week, no zone involved)
//   v_spend_weekly_by_store   order totals per week and store; weeks are cut in the household's
//                             zone by the database (history_time_zone)
//   v_most_bought_products    products on confirmed orders, most bought first, with the pin flag
//
// Retailer terms (docs/04-integrations.md §Kroger, R21): nothing here keeps a product amount. A
// product name and size are shown exactly as the household saw them, and none of these queries is
// persisted to the device.
import {
  HISTORY_LIMITS,
  MealsCookedWeek,
  MostBoughtRow,
  recentWeeks,
  SpendWeekRow,
  weekStartFor,
} from "@mp/core";
import type { MpClient } from "./client";
import { OrderError, toOrderError } from "./orders";

// ---------------------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------------------

export const historyRootKey = (householdId: string | null | undefined) =>
  ["history", householdId] as const;

export const mealsCookedKey = (householdId: string | null | undefined, fromWeek: string) =>
  ["history", householdId, "meals", fromWeek] as const;

export const spendWeeklyKey = (householdId: string | null | undefined, fromWeek: string) =>
  ["history", householdId, "spend", fromWeek] as const;

export const mostBoughtKey = (householdId: string | null | undefined) =>
  ["history", householdId, "most-bought"] as const;

/**
 * The Monday the History tabs start from: `weeks` weeks including the current one. `today` is a
 * calendar date; the app passes the device's own date until households carry a zone.
 */
export function historyFromWeek(today: string, weeks: number = HISTORY_LIMITS.weeks): string {
  const list = recentWeeks(today, weeks);
  return list[list.length - 1] ?? weekStartFor(today);
}

// ---------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------

function parseRows<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  rows: readonly unknown[] | null,
  what: string,
): T[] {
  return (rows ?? []).map((row) => {
    const parsed = schema.safeParse(row);
    if (!parsed.success) throw new OrderError("unknown", `a ${what} row did not match its schema`);
    return parsed.data;
  });
}

/** Weeks with something cooked, newest first, from `fromWeek` (a Monday) on. */
export async function fetchMealsCooked(
  client: MpClient,
  householdId: string,
  fromWeek: string,
): Promise<MealsCookedWeek[]> {
  const { data, error, status } = await client
    .from("v_meals_cooked_weekly")
    .select("household_id, week_start, cooked_count, entries")
    .eq("household_id", householdId)
    .gte("week_start", fromWeek)
    .order("week_start", { ascending: false });
  if (error) throw toOrderError(error, status);
  return parseRows(MealsCookedWeek, data, "cooked week");
}

/** Order totals per week and store, newest week first, from `fromWeek` (a Monday) on. */
export async function fetchSpendWeekly(
  client: MpClient,
  householdId: string,
  fromWeek: string,
): Promise<SpendWeekRow[]> {
  const { data, error, status } = await client
    .from("v_spend_weekly_by_store")
    .select("household_id, week_start, retailer, store_name, total_usd, order_count")
    .eq("household_id", householdId)
    .gte("week_start", fromWeek)
    .order("week_start", { ascending: false })
    .order("total_usd", { ascending: false });
  if (error) throw toOrderError(error, status);
  return parseRows(SpendWeekRow, data, "spend");
}

const MOST_BOUGHT_COLUMNS =
  "household_id, retailer, store_id, store_name, ingredient_id, product_id, upc, product_name, size, times_bought, units_bought, last_bought_at, pinned";

/** The household's most bought products: top `limit` by times bought, then most recent. */
export async function fetchMostBought(
  client: MpClient,
  householdId: string,
  limit: number = HISTORY_LIMITS.mostBought,
): Promise<MostBoughtRow[]> {
  const { data, error, status } = await client
    .from("v_most_bought_products")
    .select(MOST_BOUGHT_COLUMNS)
    .eq("household_id", householdId)
    .order("times_bought", { ascending: false })
    .order("last_bought_at", { ascending: false })
    .limit(limit);
  if (error) throw toOrderError(error, status);
  return parseRows(MostBoughtRow, data, "most bought");
}

// ---------------------------------------------------------------------------------------
// Pinning
// ---------------------------------------------------------------------------------------

/** The key product_matches pins by, from a most-bought row. Null when the row cannot be pinned. */
export function pinKey(row: MostBoughtRow) {
  if (row.store_id === null || row.ingredient_id === null) return null;
  return {
    household_id: row.household_id,
    retailer: row.retailer,
    store_id: row.store_id,
    ingredient_id: row.ingredient_id,
    product_id: row.product_id,
  };
}

/**
 * Pins or unpins a product: "always buy this" for its ingredient at its store. This is a write to
 * the household's own product_matches row, and a client write carries chosen_by = 'user' (the
 * policy requires it). The approve step already wrote the row when the product was chosen, so
 * this is normally an update; if the row is gone, pinning writes it again from the order's own
 * name and ids, and unpinning has nothing to undo.
 */
export async function setPinned(
  client: MpClient,
  row: MostBoughtRow,
  pinned: boolean,
): Promise<void> {
  const key = pinKey(row);
  if (!key) throw new OrderError("invalid", "this product has no ingredient to pin it to");

  const update = async (): Promise<number> => {
    const { data, error, status } = await client
      .from("product_matches")
      .update({ pinned, chosen_by: "user" })
      .eq("household_id", key.household_id)
      .eq("retailer", key.retailer)
      .eq("store_id", key.store_id)
      .eq("ingredient_id", key.ingredient_id)
      .eq("product_id", key.product_id)
      .select("id");
    if (error) throw toOrderError(error, status);
    return (data ?? []).length;
  };

  if ((await update()) > 0 || !pinned) return;

  if (!row.product_name) throw new OrderError("invalid", "this product has no name to remember");
  const { error, status } = await client.from("product_matches").insert({
    ...key,
    upc: row.upc,
    product_name: row.product_name,
    size: row.size,
    chosen_by: "user",
    pinned: true,
  });
  if (!error) return;
  // Someone pinned it between our update and our insert: the row exists now, so update it.
  if (error.code === "23505" && (await update()) > 0) return;
  throw toOrderError(error, status);
}

/** The rows with one product's pin flag changed: the optimistic edit, and its undo. */
export function withPinned(
  rows: readonly MostBoughtRow[],
  target: MostBoughtRow,
  pinned: boolean,
): MostBoughtRow[] {
  return rows.map((row) =>
    row.retailer === target.retailer &&
    row.store_id === target.store_id &&
    row.ingredient_id === target.ingredient_id &&
    row.product_id === target.product_id
      ? { ...row, pinned }
      : row,
  );
}
