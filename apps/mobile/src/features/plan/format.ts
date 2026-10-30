// Display helpers for the planner (WS04). Pure, so they are unit-tested.
//
// Dates are calendar dates ("2026-11-03"), and the names come from fixed English tables rather
// than Intl, so a phone's time zone or locale cannot shift a day or change a word (the app is
// English only so far).
import { addDays, type MealEntryStatus, type MealSlot, mondayIndex, weekDates } from "@mp/core";
import type { PlanEntry } from "@mp/db";

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export const SLOT_LABELS: Record<MealSlot, string> = {
  breakfast: "Breakfast",
  lunch: "Lunch",
  dinner: "Dinner",
  snack: "Snack",
};

function parts(date: string): { y: number; m: number; d: number } {
  const [y, m, d] = date.split("-").map(Number);
  return { y: y ?? 0, m: m ?? 1, d: d ?? 1 };
}

/** "Tuesday". */
export function dayName(date: string): string {
  return DAY_NAMES[mondayIndex(date)] ?? "";
}

/** "Tue". */
export function shortDayName(date: string): string {
  return dayName(date).slice(0, 3);
}

/** "Nov 3". */
export function shortMonthDay(date: string): string {
  const { m, d } = parts(date);
  return `${(MONTH_NAMES[m - 1] ?? "").slice(0, 3)} ${d}`;
}

/** "Tuesday, November 3". */
export function longDate(date: string): string {
  const { m, d } = parts(date);
  return `${dayName(date)}, ${MONTH_NAMES[m - 1] ?? ""} ${d}`;
}

/** "Nov 2 to 8, 2026", "Oct 26 to Nov 1, 2026", "Dec 28, 2026 to Jan 3, 2027". */
export function weekRangeLabel(weekStart: string): string {
  const days = weekDates(weekStart);
  const first = days[0] ?? weekStart;
  const last = days[6] ?? weekStart;
  const a = parts(first);
  const b = parts(last);
  if (a.y !== b.y) return `${shortMonthDay(first)}, ${a.y} to ${shortMonthDay(last)}, ${b.y}`;
  if (a.m === b.m) return `${shortMonthDay(first)} to ${b.d}, ${b.y}`;
  return `${shortMonthDay(first)} to ${shortMonthDay(last)}, ${b.y}`;
}

/** "This week", "Next week", "Last week", "3 weeks ahead", "2 weeks ago". Both are Mondays. */
export function relativeWeekLabel(weekStart: string, thisWeek: string): string {
  const [ya, ma, da] = weekStart.split("-").map(Number);
  const [yb, mb, db] = thisWeek.split("-").map(Number);
  const gap = Date.UTC(ya ?? 0, (ma ?? 1) - 1, da ?? 1) - Date.UTC(yb ?? 0, (mb ?? 1) - 1, db ?? 1);
  const weeks = Math.round(gap / (7 * 24 * 60 * 60 * 1000));
  if (weeks === 0) return "This week";
  if (weeks === 1) return "Next week";
  if (weeks === -1) return "Last week";
  return weeks > 0 ? `${weeks} weeks ahead` : `${-weeks} weeks ago`;
}

/** "Tuesday dinner", for labels and titles. */
export function slotTitle(date: string, slot: MealSlot): string {
  return `${dayName(date)} ${SLOT_LABELS[slot].toLowerCase()}`;
}

/** The day before or after, for the day screen's arrows. */
export function neighborDay(date: string, direction: 1 | -1): string {
  return addDays(date, direction);
}

export function servingsLabel(servings: number): string {
  const text = Number.isInteger(servings) ? String(servings) : String(Number(servings.toFixed(2)));
  return servings === 1 ? "1 serving" : `${text} servings`;
}

export const STATUS_LABELS: Record<MealEntryStatus, string> = {
  planned: "Planned",
  cooked: "Cooked",
  skipped: "Skipped",
};

/** What a planned recipe is called. A deleted or unreadable recipe still gets a row, not a hole. */
export function entryTitle(entry: Pick<PlanEntry, "recipe">): string {
  if (!entry.recipe) return "Recipe unavailable";
  if (entry.recipe.deleted_at) return `${entry.recipe.title} (deleted)`;
  return entry.recipe.title;
}

/** The spoken form of an entry: "Lemon chicken, 4 servings, cooked". */
export function entryA11yLabel(entry: PlanEntry): string {
  const status = entry.status === "planned" ? null : STATUS_LABELS[entry.status].toLowerCase();
  return [entryTitle(entry), servingsLabel(entry.servings), status]
    .filter((part): part is string => part !== null)
    .join(", ");
}

/** True when `date` is the calendar day `today`. */
export function isSameDay(date: string, today: string): boolean {
  return date === today;
}
