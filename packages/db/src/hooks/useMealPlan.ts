import { weekStartFor } from "@mp/core";
import { useQuery } from "@tanstack/react-query";
import { useSupabase } from "../context";
import { fetchMealPlan, mealPlanKey } from "../planning";
import { useHousehold } from "./useHousehold";

/**
 * The active household's plan for a week, or null when nothing has been planned yet. `weekStart`
 * may be any date in the week; it is snapped to the Monday.
 *
 * Viewing a week never creates its plan. The row is made when the first entry is added
 * (useUpsertEntry), so browsing ahead leaves no empty plans behind.
 *
 * The query key is ['meal-plan', householdId, weekStart]. Every entry change invalidates it, and
 * the grocery list (WS05) listens to it to offer "your list is out of date". It is persisted to
 * device storage so the week opens offline; the household is in the key, so another household's
 * plan can never appear under it.
 */
export function useMealPlan(weekStart: string) {
  const client = useSupabase();
  const household = useHousehold();
  const householdId = household.data?.id;
  const monday = weekStartFor(weekStart);

  return useQuery({
    queryKey: mealPlanKey(householdId, monday),
    enabled: Boolean(householdId),
    meta: { persist: true },
    queryFn: () => {
      if (!householdId) return Promise.resolve(null);
      return fetchMealPlan(client, householdId, monday);
    },
  });
}
