// Routes the planner links to and from (WS04).
import type { MealSlot } from "@mp/core";

export const PLAN_ROUTE = "/plan";
export const MENU_ROUTE = "/menu";

/**
 * Where "Generate list" goes: the grocery list screen (WS05, apps/mobile/app/(app)/list/index.tsx).
 * `?build=1` asks that screen to build the week's list on arrival when the week has none, so the
 * button is one tap. Null would disable the button and show GROCERY_LIST_PENDING_HINT.
 */
export const GROCERY_LIST_ROUTE: string | null = "/list?build=1";

export const GROCERY_LIST_PENDING_HINT = "Grocery lists arrive in the next update.";

/** The week view, optionally for another week. Omit `weekStart` for this week. */
export function planRoute(weekStart?: string): string {
  return weekStart ? `${PLAN_ROUTE}?week=${weekStart}` : PLAN_ROUTE;
}

export const dayRoute = (date: string) => `${PLAN_ROUTE}/${date}`;

/**
 * The recipe picker. With `entry` it swaps that entry's recipe instead of adding a new entry.
 * Only ids, dates and slot names go in the URL.
 */
export function pickRoute(args: { date: string; slot: MealSlot; entry?: string }): string {
  const entry = args.entry ? `&entry=${args.entry}` : "";
  return `${PLAN_ROUTE}/pick?date=${args.date}&slot=${args.slot}${entry}`;
}

export const recipeRoute = (id: string) => `/recipes/${id}`;
