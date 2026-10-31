// Routes the planner links to and from (WS04).
import { isIsoDate, MealSlot } from "@mp/core";

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

/** What the recipe picker was opened for: a day and slot, and the entry being swapped if any. */
export interface PickerTarget {
  date: string;
  slot: MealSlot;
  entry?: string | undefined;
}

/**
 * The recipe picker. With `entry` it swaps that entry's recipe instead of adding a new entry.
 * With `added` it opens on a recipe the person just saved (see `afterRecipeSaved`). Only ids,
 * dates and slot names go in the URL.
 */
export function pickRoute(args: PickerTarget & { added?: string | undefined }): string {
  const entry = args.entry ? `&entry=${args.entry}` : "";
  const added = args.added ? `&added=${args.added}` : "";
  return `${PLAN_ROUTE}/pick?date=${args.date}&slot=${args.slot}${entry}${added}`;
}

export const recipeRoute = (id: string) => `/recipes/${id}`;

export const NEW_RECIPE_ROUTE = "/recipes/new";

/** The `returnTo` value that says the picker sent the person to the add-recipe screen. */
const RETURN_TO_PICKER = "pick";

/**
 * The add-recipe screen, opened from the picker. The picker's own date, slot and swap target ride
 * along as params so that saving a recipe can bring the person back to the same picker.
 */
export function newRecipeFromPickerRoute(target: PickerTarget): string {
  const entry = target.entry ? `&entry=${target.entry}` : "";
  return `${NEW_RECIPE_ROUTE}?returnTo=${RETURN_TO_PICKER}&date=${target.date}&slot=${target.slot}${entry}`;
}

/**
 * The picker to return to, read from the add-recipe screen's params, or null when the person came
 * from anywhere else (the Recipes tab, a share, a link). Anything malformed counts as "anywhere
 * else", so a hand-edited URL never strands the screen.
 */
export function parsePickerReturn(params: Record<string, unknown>): PickerTarget | null {
  if (params.returnTo !== RETURN_TO_PICKER) return null;
  const slot = MealSlot.safeParse(params.slot);
  const { date, entry } = params;
  if (typeof date !== "string" || !isIsoDate(date) || !slot.success) return null;
  return {
    date,
    slot: slot.data,
    ...(typeof entry === "string" && entry ? { entry } : {}),
  };
}

export type SavedRecipeNavigation =
  | { action: "replace"; href: string }
  | { action: "dismissTo"; href: string };

/**
 * Where the add-recipe screen goes once a recipe is saved. From the Recipes tab (or anywhere but
 * the picker) it replaces itself with the new recipe's page, as it always has. From the picker it
 * pops back to the picker that is still underneath and hands it the new recipe's id; if that
 * picker is gone (a reload on the web), `dismissTo` puts a fresh one in its place instead.
 */
export function afterRecipeSaved(
  recipeId: string,
  returnTo: PickerTarget | null | undefined,
): SavedRecipeNavigation {
  if (returnTo) return { action: "dismissTo", href: pickRoute({ ...returnTo, added: recipeId }) };
  return { action: "replace", href: recipeRoute(recipeId) };
}
