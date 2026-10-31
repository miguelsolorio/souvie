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

/** A query parameter, encoded: a value is data, and never gets to add a parameter of its own. */
const param = (name: string, value: string) => `${name}=${encodeURIComponent(value)}`;

/** Ids here are database UUIDs. Anything else in an `entry` parameter did not come from this app. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);

/**
 * The recipe picker. With `entry` it swaps that entry's recipe instead of adding a new entry.
 * With `added` it opens on a recipe the person just saved (see `afterRecipeSaved`). Only ids,
 * dates and slot names go in the URL, each encoded.
 */
export function pickRoute(args: PickerTarget & { added?: string | undefined }): string {
  const query = [
    param("date", args.date),
    param("slot", args.slot),
    ...(args.entry ? [param("entry", args.entry)] : []),
    ...(args.added ? [param("added", args.added)] : []),
  ];
  return `${PLAN_ROUTE}/pick?${query.join("&")}`;
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
  const query = [
    param("returnTo", RETURN_TO_PICKER),
    param("date", target.date),
    param("slot", target.slot),
    ...(target.entry ? [param("entry", target.entry)] : []),
  ];
  return `${NEW_RECIPE_ROUTE}?${query.join("&")}`;
}

/**
 * The picker to return to, read from the add-recipe screen's params, or null when the person came
 * from anywhere else (the Recipes tab, a share, a link). Anything malformed counts as "anywhere
 * else", so a hand-edited URL never strands the screen. That includes an `entry` that is not a
 * UUID: sending the person back to a swap that names a made-up entry would be worse than sending
 * them to the recipe. An empty `entry` is no entry.
 */
export function parsePickerReturn(params: Record<string, unknown>): PickerTarget | null {
  if (params.returnTo !== RETURN_TO_PICKER) return null;
  const slot = MealSlot.safeParse(params.slot);
  const { date, entry } = params;
  if (typeof date !== "string" || !isIsoDate(date) || !slot.success) return null;
  if (entry === undefined || entry === "") return { date, slot: slot.data };
  if (!isUuid(entry)) return null;
  return { date, slot: slot.data, entry };
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
