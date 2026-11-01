// What the planner draws for a plan mode (WS04 follow-up: simple mode). Pure, so it is tested.
//
// Simple mode plans one dinner a day, so the week grid and the day screen draw the dinner slot and
// nothing else. The plan itself does not change: an entry in another slot (planned in Every meal
// mode, or by a housemate before the switch) is still there, still on the grocery list, and still
// reachable through a "More meals" row under its day. Nothing is hidden for good or dropped.
import {
  MEAL_SLOTS,
  type MealPlanEntry,
  type MealSlot,
  type PlanMode,
  slotsForMode,
} from "@mp/core";

/** The words on the collapsed row under a day. */
export const MORE_MEALS_LABEL = "More meals";

/**
 * One day's entries that sit outside the mode's slots, in the order a day reads (breakfast, lunch,
 * dinner, snack), each slot in its own position order. Empty in Every meal mode, and for a day
 * with only dinners in Just dinners mode. `day` is one value of `EntriesByDay`.
 */
export function moreMealsOf<T extends MealPlanEntry>(
  day: Partial<Record<MealSlot, T[]>> | undefined,
  mode: PlanMode,
): T[] {
  if (!day) return [];
  const shown = new Set<MealSlot>(slotsForMode(mode));
  return MEAL_SLOTS.filter((slot) => !shown.has(slot)).flatMap((slot) => day[slot] ?? []);
}
