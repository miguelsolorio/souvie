// Planning schemas and week math (WS04). Row shapes mirror supabase/migrations/*_planning.sql, so
// they use the database's snake_case column names. docs/02-data-model.md §Planning is the
// reference. Everything here is pure: no Node or DOM globals beyond Date, no I/O.
//
// Dates are calendar dates: "2026-11-03" means that day wherever the phone is. Week math runs on
// UTC calendar fields, never on local midnight, so a daylight saving change cannot move a date.
import { z } from "zod";

/** Timestamps as PostgREST returns them, for example 2026-10-30T07:12:14.123456+00:00. */
const Timestamp = z.iso.datetime({ offset: true });

// ---------------------------------------------------------------------------------------
// Calendar dates and weeks
// ---------------------------------------------------------------------------------------

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Splits "2026-11-03" into numbers, or null when it is not a real calendar date. */
function parseIsoDate(value: string): { y: number; m: number; d: number } | null {
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const check = new Date(Date.UTC(y, m - 1, d));
  // Date.UTC rolls 2026-02-31 over to March, so compare the fields back.
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
    return null;
  }
  return { y, m, d };
}

/** True for a real calendar date written YYYY-MM-DD. */
export function isIsoDate(value: string): boolean {
  return parseIsoDate(value) !== null;
}

/** A calendar date as the database stores it: YYYY-MM-DD, and a real day. */
export const IsoDate = z.string().refine(isIsoDate, "must be a calendar date written YYYY-MM-DD");

function utcMillis(value: string): number {
  const parts = parseIsoDate(value);
  if (!parts) throw new RangeError(`Not a calendar date (YYYY-MM-DD): ${value}`);
  return Date.UTC(parts.y, parts.m - 1, parts.d);
}

function formatUtc(millis: number): string {
  const date = new Date(millis);
  const y = String(date.getUTCFullYear()).padStart(4, "0");
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The calendar date of a Date in the device's own time zone ("today", not "today in UTC"). */
export function isoDateOf(date: Date): string {
  const y = String(date.getFullYear()).padStart(4, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** `date` plus a whole number of days (negative goes back). Both sides are calendar dates. */
export function addDays(date: string, days: number): string {
  return formatUtc(utcMillis(date) + days * MS_PER_DAY);
}

/** 0 for Monday through 6 for Sunday. */
export function mondayIndex(date: string): number {
  const weekday = new Date(utcMillis(date)).getUTCDay(); // 0 = Sunday
  return (weekday + 6) % 7;
}

/**
 * The Monday of the week that contains `date`, as YYYY-MM-DD. This is `meal_plans.week_start`.
 *
 * A string is a calendar date and is used as written. A Date is read in the device's own time
 * zone, so 23:30 on a Sunday is still that Sunday's week, and 00:30 on Monday is the next week,
 * including on the nights daylight saving starts and ends.
 */
export function weekStartFor(date: string | Date): string {
  const day = typeof date === "string" ? date : isoDateOf(date);
  return addDays(day, -mondayIndex(day));
}

/** True when `date` is a Monday. */
export function isWeekStart(date: string): boolean {
  return isIsoDate(date) && mondayIndex(date) === 0;
}

/** The seven dates of a week, Monday first. `weekStart` is any date; it is snapped to Monday. */
export function weekDates(weekStart: string): string[] {
  const monday = weekStartFor(weekStart);
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/** The Monday `weeks` weeks after (or before, when negative) the week containing `weekStart`. */
export function shiftWeek(weekStart: string, weeks: number): string {
  return addDays(weekStartFor(weekStart), weeks * 7);
}

// ---------------------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------------------

/** Postgres enum meal_plan_entries_slot, in the order a day reads. */
export const MEAL_SLOTS = ["breakfast", "lunch", "dinner", "snack"] as const;
export const MealSlot = z.enum(MEAL_SLOTS);
export type MealSlot = z.infer<typeof MealSlot>;

/** Postgres enum meal_plan_entries_status. */
export const MEAL_ENTRY_STATUSES = ["planned", "cooked", "skipped"] as const;
export const MealEntryStatus = z.enum(MEAL_ENTRY_STATUSES);
export type MealEntryStatus = z.infer<typeof MealEntryStatus>;

/** Postgres enum recipe_feedback_signal. */
export const FEEDBACK_SIGNALS = ["like", "dislike", "cooked", "skipped", "saved"] as const;
export const FeedbackSignal = z.enum(FEEDBACK_SIGNALS);
export type FeedbackSignal = z.infer<typeof FeedbackSignal>;

/** The two signals a person writes by hand; the rest come from the planner's trigger. */
export const THUMB_SIGNALS = ["like", "dislike"] as const;
export type ThumbSignal = (typeof THUMB_SIGNALS)[number];

/** Limits the database also enforces (CHECK constraints in the planning migration). */
export const PLANNING_LIMITS = {
  servingsMax: 1000,
  notes: 1000,
  position: 1000,
} as const;

/** The servings an entry gets when nothing else says. */
export const FALLBACK_SERVINGS = 4;

// ---------------------------------------------------------------------------------------
// Database rows
// ---------------------------------------------------------------------------------------

export const MealPlan = z.object({
  id: z.uuid(),
  household_id: z.uuid(),
  /** The Monday of the week. */
  week_start: IsoDate.refine(isWeekStart, "must be a Monday"),
  created_at: Timestamp,
  updated_at: Timestamp,
});
export type MealPlan = z.infer<typeof MealPlan>;

export const MealPlanEntry = z.object({
  id: z.uuid(),
  plan_id: z.uuid(),
  household_id: z.uuid(),
  date: IsoDate,
  slot: MealSlot,
  recipe_id: z.uuid(),
  servings: z.number().positive().max(PLANNING_LIMITS.servingsMax),
  status: MealEntryStatus,
  notes: z.string().max(PLANNING_LIMITS.notes).nullable(),
  /** Order within a slot, 0 first. */
  position: z.number().int().min(0).max(PLANNING_LIMITS.position),
  created_at: Timestamp,
  updated_at: Timestamp,
});
export type MealPlanEntry = z.infer<typeof MealPlanEntry>;

export const RecipeFeedback = z.object({
  id: z.uuid(),
  household_id: z.uuid(),
  user_id: z.uuid(),
  recipe_id: z.uuid(),
  signal: FeedbackSignal,
  rating: z.number().int().min(1).max(5).nullable(),
  created_at: Timestamp,
});
export type RecipeFeedback = z.infer<typeof RecipeFeedback>;

/** What a client may write when it adds or edits an entry. Everything else comes from the plan. */
export const MealPlanEntryInput = z.object({
  date: IsoDate,
  slot: MealSlot,
  recipe_id: z.uuid(),
  servings: z.number().positive().max(PLANNING_LIMITS.servingsMax),
  status: MealEntryStatus.default("planned"),
  notes: z.string().max(PLANNING_LIMITS.notes).nullable().default(null),
  position: z.number().int().min(0).max(PLANNING_LIMITS.position).default(0),
});
export type MealPlanEntryInput = z.input<typeof MealPlanEntryInput>;

/**
 * The columns a client may change on an entry that exists (swap, move, servings, status, notes,
 * reorder). A separate schema, not `MealPlanEntryInput.partial()`, because the input's defaults
 * would otherwise reset status and position on every edit.
 */
export const MealPlanEntryPatch = z
  .object({
    date: IsoDate,
    slot: MealSlot,
    recipe_id: z.uuid(),
    servings: z.number().positive().max(PLANNING_LIMITS.servingsMax),
    status: MealEntryStatus,
    notes: z.string().max(PLANNING_LIMITS.notes).nullable(),
    position: z.number().int().min(0).max(PLANNING_LIMITS.position),
  })
  .partial();
export type MealPlanEntryPatch = z.infer<typeof MealPlanEntryPatch>;

// ---------------------------------------------------------------------------------------
// Pure helpers the planner screens and hooks share
// ---------------------------------------------------------------------------------------

/** Entries for one slot on one day, in `position` order (then creation order, for stability). */
export type SlotEntries = MealPlanEntry[];

/** Entries indexed by date, then slot. A date or slot with nothing planned is absent. */
export type EntriesByDay = Record<string, Partial<Record<MealSlot, SlotEntries>>>;

export function sortEntries(entries: readonly MealPlanEntry[]): MealPlanEntry[] {
  return [...entries].sort(
    (a, b) =>
      a.position - b.position ||
      a.created_at.localeCompare(b.created_at) ||
      a.id.localeCompare(b.id),
  );
}

export function groupEntries(entries: readonly MealPlanEntry[]): EntriesByDay {
  const grouped: EntriesByDay = {};
  for (const entry of sortEntries(entries)) {
    const day = grouped[entry.date] ?? {};
    const slot = day[entry.slot] ?? [];
    slot.push(entry);
    day[entry.slot] = slot;
    grouped[entry.date] = day;
  }
  return grouped;
}

/** The position a new entry takes at the end of a slot. */
export function nextPosition(
  entries: readonly MealPlanEntry[],
  date: string,
  slot: MealSlot,
): number {
  let max = -1;
  for (const entry of entries) {
    if (entry.date === date && entry.slot === slot && entry.position > max) max = entry.position;
  }
  return Math.min(max + 1, PLANNING_LIMITS.position);
}

/**
 * How many servings to plan for a recipe. The order is the one the orchestrator set for WS04:
 * the person's own `portions` preference, then adults plus kids from their household size, then
 * what the recipe says it makes, then FALLBACK_SERVINGS. Profiles are private to each user, so
 * this reads the signed-in person's preferences only, never another member's.
 */
export function defaultServings(args: {
  preferences?: {
    portions?: number | undefined;
    household_size?: { adults: number; kids: number } | undefined;
  } | null;
  recipeServings?: number | null | undefined;
}): number {
  const { preferences, recipeServings } = args;
  if (preferences?.portions !== undefined && preferences.portions > 0) {
    return clampServings(preferences.portions);
  }
  const size = preferences?.household_size;
  if (size) {
    const people = size.adults + size.kids;
    if (people > 0) return clampServings(people);
  }
  if (recipeServings !== null && recipeServings !== undefined && recipeServings > 0) {
    return clampServings(recipeServings);
  }
  return FALLBACK_SERVINGS;
}

function clampServings(value: number): number {
  return Math.min(Math.max(value, 0.5), PLANNING_LIMITS.servingsMax);
}

/** The feedback signal an entry status change writes, or null when it writes none. */
export function signalForStatus(status: MealEntryStatus): FeedbackSignal | null {
  if (status === "cooked") return "cooked";
  if (status === "skipped") return "skipped";
  return null;
}
