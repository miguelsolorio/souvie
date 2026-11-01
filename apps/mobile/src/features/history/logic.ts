// Pure logic for the History screens (WS12): grouping the three views for display, the streak, and
// when to ask "Did you place this order?". No React Native here, so Vitest runs it.
import {
  type CookedMeal,
  cookedStreak,
  type MealsCookedWeek,
  type RetailerId,
  type SpendWeekRow,
  weekStartFor,
} from "@mp/core";
import { storeLabel } from "./format";

// ---------------------------------------------------------------------------------------
// Spend
// ---------------------------------------------------------------------------------------

export interface StoreSpend {
  /** Stable across weeks, so the same store keeps the same row key. */
  key: string;
  label: string;
  retailer: RetailerId;
  total: number;
  orders: number;
  /** 0 to 1: this store-week against the largest store-week shown, for the bar. */
  share: number;
}

export interface WeekSpend {
  weekStart: string;
  total: number;
  orders: number;
  stores: StoreSpend[];
}

const cents = (amount: number) => Math.round(amount * 100) / 100;

/**
 * The spend view's rows grouped by week, newest week first, biggest store first inside a week.
 * Bars share one scale across the weeks shown, so a quiet week looks quiet.
 */
export function groupSpend(rows: readonly SpendWeekRow[]): WeekSpend[] {
  const largest = Math.max(0, ...rows.map((row) => row.total_usd));
  const weeks = new Map<string, WeekSpend>();
  for (const row of rows) {
    const week = weeks.get(row.week_start) ?? {
      weekStart: row.week_start,
      total: 0,
      orders: 0,
      stores: [],
    };
    week.total = cents(week.total + row.total_usd);
    week.orders += row.order_count;
    week.stores.push({
      key: `${row.retailer}:${row.store_name ?? ""}`,
      label: storeLabel(row),
      retailer: row.retailer,
      total: row.total_usd,
      orders: row.order_count,
      share: largest > 0 ? row.total_usd / largest : 0,
    });
    weeks.set(row.week_start, week);
  }
  return [...weeks.values()]
    .map((week) => ({ ...week, stores: week.stores.sort((a, b) => b.total - a.total) }))
    .sort((a, b) => (a.weekStart < b.weekStart ? 1 : a.weekStart > b.weekStart ? -1 : 0));
}

/** The sum of every row, to the cent. */
export function totalSpend(rows: readonly Pick<SpendWeekRow, "total_usd">[]): number {
  return cents(rows.reduce((sum, row) => sum + row.total_usd, 0));
}

/** What one week's rows add up to. */
export function spendForWeek(rows: readonly SpendWeekRow[], weekStart: string): number {
  return totalSpend(rows.filter((row) => row.week_start === weekStart));
}

// ---------------------------------------------------------------------------------------
// Meals
// ---------------------------------------------------------------------------------------

export interface CookedDay {
  date: string;
  meals: CookedMeal[];
}

/** A week's cooked meals grouped by date, oldest day first, in the order the view sent them. */
export function cookedByDay(entries: readonly CookedMeal[]): CookedDay[] {
  const days = new Map<string, CookedMeal[]>();
  for (const meal of entries) {
    const list = days.get(meal.date);
    if (list) list.push(meal);
    else days.set(meal.date, [meal]);
  }
  return [...days.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, meals]) => ({ date, meals }));
}

/** Every date something was cooked, across the weeks loaded. */
export function allCookedDates(weeks: readonly MealsCookedWeek[]): string[] {
  return weeks.flatMap((week) => week.entries.map((meal) => meal.date));
}

export interface CookedSummary {
  /** Meals cooked in the week that holds `today`. */
  thisWeek: number;
  /** Meals cooked in every week loaded. */
  total: number;
  /** Consecutive days with something cooked, counting back from today (or yesterday). */
  streak: number;
}

export function summarizeCooked(weeks: readonly MealsCookedWeek[], today: string): CookedSummary {
  const thisWeekStart = weekStartFor(today);
  return {
    thisWeek: weeks.find((week) => week.week_start === thisWeekStart)?.cooked_count ?? 0,
    total: weeks.reduce((sum, week) => sum + week.cooked_count, 0),
    streak: cookedStreak(allCookedDates(weeks), today),
  };
}

// ---------------------------------------------------------------------------------------
// "Did you place this order?"
// ---------------------------------------------------------------------------------------

/** A run whose cart is ready (or checked out) and approved is one the household can have ordered. */
export const ORDERABLE_STATUSES: readonly string[] = ["cart_ready", "checked_out"];

/** The banner waits this long after the cart is ready before it asks again. */
export const PROMPT_AFTER_HOURS = 2;

/** And stops asking after this many days. */
export const PROMPT_UNTIL_DAYS = 7;

export interface PromptableRun {
  id: string;
  status: string;
  approved_at: string | null;
  finished_at: string | null;
}

/** True when the run could be an order nobody has confirmed yet. R19: it is only a question. */
export function canConfirm(run: Pick<PromptableRun, "status" | "approved_at"> | null): boolean {
  return run !== null && run.approved_at !== null && ORDERABLE_STATUSES.includes(run.status);
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * The run the follow-up banner asks about: the newest orderable run whose cart has been ready for
 * at least two hours and at most a week, that has no order and was not dismissed on this device.
 * Null when there is none. In-app only: no notification type is added for it.
 */
export function pickPromptRun<T extends PromptableRun>(
  runs: readonly T[],
  orderedRunIds: ReadonlySet<string>,
  dismissed: readonly string[],
  now: Date,
): T | null {
  let best: T | null = null;
  let bestAt = 0;
  for (const run of runs) {
    if (!canConfirm(run) || !run.finished_at) continue;
    if (orderedRunIds.has(run.id) || dismissed.includes(run.id)) continue;
    const at = new Date(run.finished_at).getTime();
    const age = now.getTime() - at;
    if (!(age >= PROMPT_AFTER_HOURS * HOUR_MS) || age > PROMPT_UNTIL_DAYS * 24 * HOUR_MS) continue;
    if (at > bestAt) {
      best = run;
      bestAt = at;
    }
  }
  return best;
}

/** "3 hours ago", "1 hour ago", "2 days ago": how long ago a cart was ready, rounded down. */
export function agoLabel(instant: string, now: Date): string {
  const hours = Math.floor((now.getTime() - new Date(instant).getTime()) / HOUR_MS);
  if (hours < 1) return "less than an hour ago";
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}
