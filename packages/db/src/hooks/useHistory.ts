import {
  HISTORY_LIMITS,
  isoDateOf,
  type MealsCookedWeek,
  type MostBoughtRow,
  type SpendWeekRow,
} from "@mp/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSupabase } from "../context";
import {
  fetchMealsCooked,
  fetchMostBought,
  fetchSpendWeekly,
  historyFromWeek,
  mealsCookedKey,
  mostBoughtKey,
  setPinned,
  spendWeeklyKey,
  withPinned,
} from "../history";
import type { OrderError } from "../orders";
import { useHousehold } from "./useHousehold";

// None of these queries is persisted to the device: they hold the household's spend and purchase
// history, and product names that came from a retailer.

/**
 * Weeks with something cooked, newest first, for the last `weeks` weeks (the current one
 * included). The week is the plan's own, so no zone is involved.
 */
export function useMealsCooked(weeks: number = HISTORY_LIMITS.weeks) {
  const client = useSupabase();
  const household = useHousehold();
  const householdId = household.data?.id;
  const fromWeek = historyFromWeek(isoDateOf(new Date()), weeks);
  return useQuery({
    queryKey: mealsCookedKey(householdId, fromWeek),
    enabled: Boolean(householdId),
    queryFn: (): Promise<MealsCookedWeek[]> => {
      if (!householdId) return Promise.resolve([]);
      return fetchMealsCooked(client, householdId, fromWeek);
    },
  });
}

/**
 * Order totals per week and store for the last `weeks` weeks, newest first. The database cuts the
 * weeks in the household's zone (today the launch zone for every household).
 */
export function useSpendWeekly(weeks: number = HISTORY_LIMITS.weeks) {
  const client = useSupabase();
  const household = useHousehold();
  const householdId = household.data?.id;
  const fromWeek = historyFromWeek(isoDateOf(new Date()), weeks);
  return useQuery({
    queryKey: spendWeeklyKey(householdId, fromWeek),
    enabled: Boolean(householdId),
    queryFn: (): Promise<SpendWeekRow[]> => {
      if (!householdId) return Promise.resolve([]);
      return fetchSpendWeekly(client, householdId, fromWeek);
    },
  });
}

/** The household's top products by times bought (the top 20). */
export function useMostBought() {
  const client = useSupabase();
  const household = useHousehold();
  const householdId = household.data?.id;
  return useQuery({
    queryKey: mostBoughtKey(householdId),
    enabled: Boolean(householdId),
    queryFn: (): Promise<MostBoughtRow[]> => {
      if (!householdId) return Promise.resolve([]);
      return fetchMostBought(client, householdId, HISTORY_LIMITS.mostBought);
    },
  });
}

/**
 * Pins or unpins a product ("always buy this"). The toggle shows at once and is put back if the
 * write fails; the list is read again either way, so it is the view's answer that stays.
 */
export function usePinProduct() {
  const client = useSupabase();
  const queryClient = useQueryClient();
  const household = useHousehold();
  const householdId = household.data?.id;
  const key = mostBoughtKey(householdId);

  return useMutation<
    void,
    OrderError,
    { row: MostBoughtRow; pinned: boolean },
    { before: MostBoughtRow[] | undefined }
  >({
    mutationFn: ({ row, pinned }) => setPinned(client, row, pinned),
    onMutate: async ({ row, pinned }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const before = queryClient.getQueryData<MostBoughtRow[]>(key);
      if (before) queryClient.setQueryData<MostBoughtRow[]>(key, withPinned(before, row, pinned));
      return { before };
    },
    onError: (_error, _vars, context) => {
      if (context?.before) queryClient.setQueryData(key, context.before);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
}
