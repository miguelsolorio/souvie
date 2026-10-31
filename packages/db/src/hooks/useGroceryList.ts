import type { GroceryList } from "@mp/core";
import { useQuery } from "@tanstack/react-query";
import { useSupabase } from "../context";
import {
  fetchLatestList,
  fetchListById,
  fetchListByPlan,
  groceryListByPlanKey,
  groceryListKey,
} from "../lists";
import { useHousehold } from "./useHousehold";

export interface GroceryListTarget {
  /** The plan whose list to load. Null or undefined waits (the week has no plan yet). */
  planId?: string | null | undefined;
  /** A list by id. Wins over planId when both are given. */
  listId?: string | null | undefined;
}

/**
 * A grocery list of the active household: by its plan (the list for a week), or by id. `data` is
 * null when the plan has no list yet, so the screen can offer to build one; undefined while it
 * loads or when nothing identifies a list.
 *
 * The query key is ['grocery-list', householdId, listId] for a list by id, and
 * ['grocery-list', householdId, 'plan', planId] by plan. Both are persisted to device storage so
 * the list opens in a store with no signal; the household is in the key, so another household's
 * list can never appear under it. Remote changes arrive through the Realtime subscription
 * (realtime/lists.ts), which invalidates ['grocery-list', householdId].
 */
export function useGroceryList(target: GroceryListTarget) {
  const client = useSupabase();
  const household = useHousehold();
  const householdId = household.data?.id;
  const { planId, listId } = target;

  const byId = Boolean(listId);
  return useQuery({
    queryKey: byId
      ? groceryListKey(householdId, listId)
      : groceryListByPlanKey(householdId, planId),
    enabled: Boolean(householdId && (listId || planId)),
    meta: { persist: true },
    queryFn: (): Promise<GroceryList | null> => {
      if (!householdId) return Promise.resolve(null);
      if (listId) return fetchListById(client, householdId, listId);
      if (planId) return fetchListByPlan(client, householdId, planId);
      return Promise.resolve(null);
    },
  });
}

/** The household's newest live list, for a screen that opens on "the current list" with no week. */
export function useLatestGroceryList() {
  const client = useSupabase();
  const household = useHousehold();
  const householdId = household.data?.id;

  return useQuery({
    queryKey: ["grocery-list", householdId, "latest"] as const,
    enabled: Boolean(householdId),
    meta: { persist: true },
    queryFn: (): Promise<GroceryList | null> => {
      if (!householdId) return Promise.resolve(null);
      return fetchLatestList(client, householdId);
    },
  });
}
