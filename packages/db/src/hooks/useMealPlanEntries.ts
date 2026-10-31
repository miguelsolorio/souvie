import { useQuery } from "@tanstack/react-query";
import { useSupabase } from "../context";
import {
  fetchMealPlanEntries,
  fetchRecentRecipeIds,
  mealPlanEntriesKey,
  recentRecipesKey,
} from "../planning";
import { useHousehold } from "./useHousehold";

/**
 * A plan's entries with their recipes (title, picture, times), ordered by day and slot position.
 * Pass the id from useMealPlan; with no plan yet (null or undefined) the query stays idle and
 * `data` is undefined, which the screen shows as an empty week.
 *
 * Persisted like the plan, with the household in the key. Remote changes arrive through the
 * Realtime subscription (realtime/planning.ts), which invalidates ['meal-plan', householdId].
 */
export function useMealPlanEntries(planId: string | null | undefined) {
  const client = useSupabase();
  const household = useHousehold();
  const householdId = household.data?.id;

  return useQuery({
    queryKey: mealPlanEntriesKey(householdId, planId),
    enabled: Boolean(householdId && planId),
    meta: { persist: true },
    queryFn: () => {
      if (!planId) return Promise.resolve([]);
      return fetchMealPlanEntries(client, planId);
    },
  });
}

/** The recipes the household planned most recently, newest first, each once. */
export function useRecentRecipeIds(householdId: string | null | undefined, limit = 12) {
  const client = useSupabase();

  return useQuery({
    queryKey: [...recentRecipesKey(householdId), limit] as const,
    enabled: Boolean(householdId),
    queryFn: () => {
      if (!householdId) return Promise.resolve([]);
      return fetchRecentRecipeIds(client, householdId, limit);
    },
  });
}
