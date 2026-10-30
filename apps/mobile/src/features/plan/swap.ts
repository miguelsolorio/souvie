// What a swap writes to an entry. Pure, so it is unit-tested.
//
// A swap replaces the recipe and nothing the person set. Servings and notes stay, because the sheet
// promises "Servings and notes stay". That includes a suggested swap: the model's idea of servings
// is ignored, since the household's number is theirs. The meal goes back to planned (a cooked meal
// is not "cooked" with a different dish), and the entry's `why` becomes the suggestion's one-line
// reason, or null for a recipe a person picked, so a stale reason never sits under a new recipe.
import { type MealPlanEntryPatch, PLANNING_LIMITS } from "@mp/core";

export function swapPatch(
  recipeId: string,
  why?: string | null | undefined,
): MealPlanEntryPatch & { recipe_id: string; status: "planned"; why: string | null } {
  const reason = why?.trim();
  return {
    recipe_id: recipeId,
    status: "planned",
    why: reason ? reason.slice(0, PLANNING_LIMITS.why) : null,
  };
}
