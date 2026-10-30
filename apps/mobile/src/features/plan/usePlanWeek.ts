import { type EntriesByDay, groupEntries, type MealPlan } from "@mp/core";
import {
  type PlanEntry,
  useHousehold,
  useMealPlan,
  useMealPlanEntries,
  usePlanRealtime,
} from "@mp/db";
import { useCallback, useMemo } from "react";
import "./ids";

const NO_ENTRIES: PlanEntry[] = [];

export interface PlanWeek {
  /** null until the household has loaded, and when the person has none. */
  householdId: string | null;
  /** True once the household has loaded and the person has none: send them to create one. */
  noHousehold: boolean;
  plan: MealPlan | null | undefined;
  entries: PlanEntry[];
  byDay: EntriesByDay<PlanEntry>;
  /** True while the first load of the household, plan, or entries is still running. */
  loading: boolean;
  /** True when that first load cannot finish because the device is offline and nothing is cached. */
  offline: boolean;
  error: boolean;
  refreshing: boolean;
  refetch: () => void;
}

/**
 * Everything the week view and the day screen need for one week: the plan, its entries with their
 * recipes, and the entries grouped by day and slot. It also keeps the household's Realtime
 * channel open, so another member's change shows up here on its own.
 *
 * Viewing a week never creates its plan: `plan` is null for a week nobody has planned.
 */
export function usePlanWeek(weekStart: string): PlanWeek {
  const household = useHousehold();
  const householdId = household.data?.id ?? null;
  const plan = useMealPlan(weekStart);
  const planId = plan.data?.id ?? null;
  const entries = useMealPlanEntries(planId);
  usePlanRealtime(householdId);

  const list = entries.data ?? NO_ENTRIES;
  const byDay = useMemo(() => groupEntries(list), [list]);

  const waitingOnHousehold = household.isPending;
  const waitingOnPlan = householdId !== null && plan.isPending;
  const waitingOnEntries = planId !== null && entries.isPending;
  const loading = waitingOnHousehold || waitingOnPlan || waitingOnEntries;
  const paused =
    (waitingOnHousehold && household.fetchStatus === "paused") ||
    (waitingOnPlan && plan.fetchStatus === "paused") ||
    (waitingOnEntries && entries.fetchStatus === "paused");

  const refetchHousehold = household.refetch;
  const refetchPlan = plan.refetch;
  const refetchEntries = entries.refetch;
  const refetch = useCallback(() => {
    void refetchHousehold();
    void refetchPlan();
    if (planId) void refetchEntries();
  }, [refetchHousehold, refetchPlan, refetchEntries, planId]);

  return {
    householdId,
    noHousehold: !household.isPending && !household.isError && !household.data,
    plan: plan.data,
    entries: list,
    byDay,
    loading: loading && !paused,
    offline: loading && paused,
    error: household.isError || plan.isError || entries.isError,
    refreshing: plan.isRefetching || entries.isRefetching,
    refetch,
  };
}
