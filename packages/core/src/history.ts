// History and spend (WS12): the order row, the three history views, and the pure helpers the History
// screens share. Row shapes mirror supabase/migrations/*_ws12_orders_history.sql, so they use the
// database's snake_case column names. docs/02-data-model.md §Retail (orders) and §Views are the
// reference. Everything here is pure: no I/O, and no globals beyond Date and Intl.
//
// Weeks are Monday to Sunday. A calendar date ("2026-11-03") is used as written. An instant (a
// Date, or a timestamp such as orders.confirmed_at) is read in a time zone: the one passed in, or
// the device's own when none is. The database cuts the spend view's weeks in the household's zone
// (history_time_zone), so a caller that has that zone passes it here to agree with the view.
import { z } from "zod";
import {
  addDays,
  IsoDate,
  isIsoDate,
  isoDateOf,
  MealSlot,
  shiftWeek,
  weekStartFor,
} from "./planning.ts";
import { Modality, RetailerId } from "./retail.ts";

// Ids in the rows below come from our own database, so they are read as guids (any 8-4-4-4-12
// hex) rather than strict RFC 4122 versions: one seeded row with an unusual id must not blank a
// screen.

/** Timestamps as PostgREST returns them, for example 2026-10-30T07:12:14.123456+00:00. */
const Timestamp = z.iso.datetime({ offset: true });

/** numeric columns arrive as JSON numbers or, from some paths, as strings. Both read as numbers. */
const Numeric = z.preprocess(
  (value) => (typeof value === "string" && value.trim() !== "" ? Number(value) : value),
  z.number().finite(),
);

// ---------------------------------------------------------------------------------------
// Limits the database also enforces (CHECK constraints in the WS12 migration)
// ---------------------------------------------------------------------------------------

export const HISTORY_LIMITS = {
  /** orders.total_usd runs from 0 to this. */
  orderTotalMax: 100_000,
  notes: 1000,
  retailerOrderId: 100,
  /** A pickup or delivery window is at most this many hours long. */
  windowMaxHours: 24,
  /** "Most bought" shows this many products. */
  mostBought: 20,
  /** The History tabs look back this many weeks. */
  weeks: 12,
} as const;

// ---------------------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------------------

/** Postgres enum orders_status. */
export const ORDER_STATUSES = ["confirmed", "picked_up", "delivered", "cancelled"] as const;
export const OrderStatus = z.enum(ORDER_STATUSES);
export type OrderStatus = z.infer<typeof OrderStatus>;

/** An order that counts toward spend: everything except a cancelled one. */
export function countsAsSpend(status: OrderStatus): boolean {
  return status !== "cancelled";
}

/** An orders row as the app reads it. `raw` (Tier 3 details) is never selected by a client. */
export const Order = z.object({
  id: z.guid(),
  household_id: z.guid(),
  run_id: z.guid(),
  retailer: RetailerId,
  retailer_order_id: z.string().nullable(),
  modality: Modality,
  slot_start: Timestamp.nullable(),
  slot_end: Timestamp.nullable(),
  total_usd: Numeric.pipe(z.number().min(0).max(HISTORY_LIMITS.orderTotalMax)),
  status: OrderStatus,
  confirmed_by: z.guid().nullable(),
  confirmed_at: Timestamp,
  notes: z.string().max(HISTORY_LIMITS.notes).nullable(),
  created_at: Timestamp,
  updated_at: Timestamp,
});
export type Order = z.infer<typeof Order>;

/** Why a pickup or delivery window is not acceptable, or null when it is (or is empty). */
export type OrderWindowError = "end_without_start" | "end_not_after_start" | "too_long";

/**
 * Checks a window the way the orders table does: an end needs a start, the end is after the start,
 * and the window is at most a day long. Both ends are optional. Reads timestamps, not times of day.
 */
export function orderWindowError(
  start: string | Date | null | undefined,
  end: string | Date | null | undefined,
): OrderWindowError | null {
  if (end === null || end === undefined) return null;
  if (start === null || start === undefined) return "end_without_start";
  const from = new Date(start).getTime();
  const to = new Date(end).getTime();
  if (!(to > from)) return "end_not_after_start";
  if (to - from > HISTORY_LIMITS.windowMaxHours * 60 * 60 * 1000) return "too_long";
  return null;
}

/**
 * What a person gives when they say "I placed it": the total they paid, how it is fulfilled, and
 * optionally the window, the store's order number and a note. The run, household, retailer and the
 * person confirming come from the database, never from here.
 */
export const ConfirmOrderInput = z
  .object({
    total: z.number().min(0).max(HISTORY_LIMITS.orderTotalMax),
    modality: Modality.optional(),
    slotStart: Timestamp.nullish(),
    slotEnd: Timestamp.nullish(),
    retailerOrderId: z.string().trim().max(HISTORY_LIMITS.retailerOrderId).nullish(),
    notes: z.string().trim().max(HISTORY_LIMITS.notes).nullish(),
  })
  .superRefine((input, ctx) => {
    const problem = orderWindowError(input.slotStart, input.slotEnd);
    if (problem) ctx.addIssue({ code: "custom", message: problem, path: ["slotEnd"] });
  });
export type ConfirmOrderInput = z.input<typeof ConfirmOrderInput>;

/** The columns a person may correct on an order that exists. */
export const OrderPatch = z
  .object({
    total_usd: z.number().min(0).max(HISTORY_LIMITS.orderTotalMax),
    modality: Modality,
    slot_start: Timestamp.nullable(),
    slot_end: Timestamp.nullable(),
    retailer_order_id: z.string().trim().max(HISTORY_LIMITS.retailerOrderId).nullable(),
    notes: z.string().trim().max(HISTORY_LIMITS.notes).nullable(),
    status: OrderStatus,
  })
  .partial();
export type OrderPatch = z.infer<typeof OrderPatch>;

/**
 * Reads a dollar amount a person typed: "123.45", "$1,234.5", " 40 ". Returns whole cents as
 * dollars (two decimals), or null when it is not an amount from $0 to the limit.
 */
export function parseMoneyInput(text: string): number | null {
  const cleaned = text.trim().replace(/^\$/, "").replace(/,/g, "").trim();
  if (!/^(\d+(\.\d{0,2})?|\.\d{1,2})$/.test(cleaned)) return null;
  const amount = Math.round(Number(cleaned) * 100) / 100;
  return amount >= 0 && amount <= HISTORY_LIMITS.orderTotalMax ? amount : null;
}

// ---------------------------------------------------------------------------------------
// The three views
// ---------------------------------------------------------------------------------------

/** One cooked meal inside v_meals_cooked_weekly.entries. `title` is null if the recipe is gone. */
export const CookedMeal = z.object({
  id: z.guid(),
  date: IsoDate,
  slot: MealSlot,
  recipe_id: z.guid(),
  title: z.string().nullable(),
});
export type CookedMeal = z.infer<typeof CookedMeal>;

/** A row of v_meals_cooked_weekly: a plan week with at least one cooked meal. */
export const MealsCookedWeek = z.object({
  household_id: z.guid(),
  week_start: IsoDate,
  cooked_count: z.number().int().min(0),
  entries: z.array(CookedMeal),
});
export type MealsCookedWeek = z.infer<typeof MealsCookedWeek>;

/** A row of v_spend_weekly_by_store. `store_name` is null when the run recorded none. */
export const SpendWeekRow = z.object({
  household_id: z.guid(),
  week_start: IsoDate,
  retailer: RetailerId,
  store_name: z.string().nullable(),
  total_usd: Numeric.pipe(z.number().min(0)),
  order_count: z.number().int().min(1),
});
export type SpendWeekRow = z.infer<typeof SpendWeekRow>;

/**
 * A row of v_most_bought_products. It carries the key product_matches pins by (retailer,
 * store_id, ingredient_id, product_id); `ingredient_id` is null for a free-text line, which
 * cannot be pinned. A name and size are shown exactly as the household saw them. No amounts.
 */
export const MostBoughtRow = z.object({
  household_id: z.guid(),
  retailer: RetailerId,
  store_id: z.string().nullable(),
  /** The store's name as the latest run recorded it. */
  store_name: z.string().nullable(),
  ingredient_id: z.guid().nullable(),
  product_id: z.string(),
  upc: z.string().nullable(),
  product_name: z.string().nullable(),
  size: z.string().nullable(),
  times_bought: z.number().int().min(1),
  units_bought: Numeric,
  last_bought_at: Timestamp,
  pinned: z.boolean(),
});
export type MostBoughtRow = z.infer<typeof MostBoughtRow>;

/** True when the app can write a pin for this product: product_matches needs all four key parts. */
export function canPin(row: Pick<MostBoughtRow, "store_id" | "ingredient_id">): boolean {
  return row.store_id !== null && row.ingredient_id !== null;
}

// ---------------------------------------------------------------------------------------
// Weeks
// ---------------------------------------------------------------------------------------

const zoneFormats = new Map<string, Intl.DateTimeFormat | null>();

function zoneFormat(tz: string): Intl.DateTimeFormat | null {
  if (zoneFormats.has(tz)) return zoneFormats.get(tz) ?? null;
  let format: Intl.DateTimeFormat | null = null;
  try {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    // An unknown zone name, or a runtime without that zone: the caller falls back to the device.
    format = null;
  }
  zoneFormats.set(tz, format);
  return format;
}

/** The calendar date of an instant in a time zone, YYYY-MM-DD. Without a zone, the device's own. */
function localDate(instant: Date, tz: string | undefined): string {
  const format = tz ? zoneFormat(tz) : null;
  if (!format) return isoDateOf(instant);
  const parts = format.formatToParts(instant);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year").padStart(4, "0")}-${pick("month")}-${pick("day")}`;
}

/**
 * The Monday of the week that holds `date`, as YYYY-MM-DD (the same value as meal_plans.week_start).
 *
 * A plain calendar date string is used as written. A Date, or a timestamp string, is an instant: it
 * is read in `tz` (an IANA name such as "America/Los_Angeles"), or in the device's own zone when
 * `tz` is left out or unknown. So Sunday 23:30 is still that Sunday's week and Monday 00:30 is the
 * next, wherever the instant falls in UTC.
 */
export function weekStart(date: string | Date, tz?: string): string {
  if (typeof date === "string" && isIsoDate(date)) return weekStartFor(date);
  const instant = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(instant.getTime())) throw new RangeError(`Not a date or timestamp: ${date}`);
  return weekStartFor(localDate(instant, tz));
}

export interface WeekGroup<T> {
  /** The Monday of the week. */
  weekStart: string;
  items: T[];
}

/**
 * Groups items by the week of their date, newest week first. Items keep their input order inside a
 * week. `dateOf` returns a calendar date or an instant (see `weekStart`).
 */
export function groupByWeek<T>(
  items: readonly T[],
  dateOf: (item: T) => string | Date,
  tz?: string,
): WeekGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = weekStart(dateOf(item), tz);
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([key, bucket]) => ({ weekStart: key, items: bucket }));
}

/**
 * The Mondays of the last `count` weeks, newest first, starting with the week that holds `today`.
 * History tabs read this range.
 */
export function recentWeeks(today: string, count: number = HISTORY_LIMITS.weeks): string[] {
  const thisWeek = weekStartFor(today);
  return Array.from({ length: Math.max(0, count) }, (_, i) => shiftWeek(thisWeek, -i));
}

/**
 * Consecutive days with something cooked, counting back from `today`. If nothing is cooked yet
 * today the streak still stands and counts from yesterday, since the day is not over. A day with
 * no cooked meal ends it. `cookedDates` are calendar dates; repeats and order do not matter.
 */
export function cookedStreak(cookedDates: Iterable<string>, today: string): number {
  const days = new Set(cookedDates);
  let day = days.has(today) ? today : addDays(today, -1);
  let streak = 0;
  while (days.has(day)) {
    streak += 1;
    day = addDays(day, -1);
  }
  return streak;
}
