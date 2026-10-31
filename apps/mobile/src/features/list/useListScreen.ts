import {
  type GroceryList,
  type GroceryListItem,
  isoDateOf,
  type MealPlan,
  weekStartFor,
} from "@mp/core";
import {
  isListStale,
  listErrorMessage,
  useBuildList,
  useGroceryList,
  useGroceryListItems,
  useHousehold,
  useListRealtime,
  useMealPlan,
  useMealPlanEntries,
  usePlanRealtime,
  usePlanWeekStart,
} from "@mp/db";
import { useCallback, useMemo } from "react";
import "../plan/ids";
import "../plan/persistHousehold";
import "./queueStorage";
import { type ListSplit, type Progress, progressOf, splitItems } from "./logic";

const NO_ITEMS: GroceryListItem[] = [];

export interface ListScreenData {
  /** null until the household has loaded, and when the person has none. */
  householdId: string | null;
  /** True once the household has loaded and the person has none: send them to create one. */
  noHousehold: boolean;
  /** True while the household, the plan, or the list is loading for the first time. */
  loading: boolean;
  /** True when that first load cannot finish because the device is offline and nothing is saved. */
  offline: boolean;
  /** A load failed and there is nothing saved on this device to show instead. */
  error: boolean;
  /** A refresh failed, but a saved copy is on screen. */
  staleCopy: boolean;
  refreshing: boolean;
  refetch: () => void;

  /** The Monday of the list's week, when known. */
  weekStart: string | null;
  plan: MealPlan | null | undefined;
  /** Dinners and other meals that will be shopped for (everything not skipped). */
  mealCount: number;
  /** null when the week has no list yet. */
  list: GroceryList | null | undefined;
  items: GroceryListItem[];
  split: ListSplit;
  progress: Progress;
  /** The plan changed after the list was built. */
  stale: boolean;
  /** Writes saved on this device and not yet on the server. */
  pending: number;
  /** Build or rebuild the list from the plan. */
  build: { run: () => void; building: boolean; error: string | null };
}

/**
 * Everything the list screens need for one list: the week's plan, the list built from it, its
 * items (with the writes still waiting in the replay queue laid over them), whether the plan
 * changed since, and the build action. It also keeps both Realtime channels open, so another
 * member's check-off, or a change to the plan, shows up on its own.
 *
 * Open a week's list with `weekStart` (the plan's list, built on request) or a known list with
 * `listId`.
 */
export function useListScreen(args: {
  weekStart?: string | null;
  listId?: string | null;
}): ListScreenData {
  const household = useHousehold();
  const householdId = household.data?.id ?? null;
  const byList = Boolean(args.listId);
  const weekStart = args.weekStart ? weekStartFor(args.weekStart) : null;

  // A list opened by id does not need a plan lookup by week; the planner's cached current week
  // stands in so the hook order never changes.
  const plan = useMealPlan(weekStart ?? weekStartFor(isoDateOf(new Date())));
  const listByWeek = useGroceryList({ planId: byList ? null : (plan.data?.id ?? null) });
  const listById = useGroceryList({ listId: args.listId ?? null });
  const list = byList ? listById.data : listByWeek.data;
  const listQuery = byList ? listById : listByWeek;

  const planId = list?.plan_id ?? (byList ? null : (plan.data?.id ?? null));
  const entries = useMealPlanEntries(planId);
  const itemsQuery = useGroceryListItems(list?.id);
  const planWeek = usePlanWeekStart(byList ? list?.plan_id : null);
  usePlanRealtime(householdId);
  useListRealtime(householdId);

  const items = itemsQuery.data ?? NO_ITEMS;
  const split = useMemo(() => splitItems(items), [items]);
  const progress = useMemo(() => progressOf(split.toBuy), [split.toBuy]);
  const mealCount = useMemo(
    () => (entries.data ?? []).filter((entry) => entry.status !== "skipped").length,
    [entries.data],
  );
  const stale = entries.data !== undefined && list ? isListStale(list, entries.data) : false;

  const buildMutation = useBuildList();
  const weekForBuild = byList ? (planWeek.data ?? null) : weekStart;
  const { mutate } = buildMutation;
  const run = useCallback(() => {
    if (weekForBuild) mutate({ weekStart: weekForBuild });
  }, [mutate, weekForBuild]);

  const waitingOnHousehold = household.isPending;
  const waitingOnPlan = !byList && householdId !== null && plan.isPending;
  const waitingOnList = listQuery.isPending && listQuery.fetchStatus !== "idle";
  const waitingOnItems = list != null && itemsQuery.isPending;
  const waiting = waitingOnHousehold || waitingOnPlan || waitingOnList || waitingOnItems;
  const paused =
    (waitingOnHousehold && household.fetchStatus === "paused") ||
    (waitingOnPlan && plan.fetchStatus === "paused") ||
    (waitingOnList && listQuery.fetchStatus === "paused") ||
    (waitingOnItems && itemsQuery.fetchStatus === "paused");
  const failed =
    household.isError || (!byList && plan.isError) || listQuery.isError || itemsQuery.isError;
  const hasCopy = householdId !== null && (byList ? list !== undefined : plan.data !== undefined);

  const refetchHousehold = household.refetch;
  const refetchPlan = plan.refetch;
  const refetchList = listQuery.refetch;
  const refetchItems = itemsQuery.refetch;
  const refetch = useCallback(() => {
    void refetchHousehold();
    if (!byList) void refetchPlan();
    void refetchList();
    if (list) void refetchItems();
  }, [refetchHousehold, refetchPlan, refetchList, refetchItems, byList, list]);

  return {
    householdId,
    noHousehold: !household.isPending && !household.isError && !household.data,
    loading: waiting && !paused,
    offline: waiting && paused,
    error: failed && !hasCopy,
    staleCopy: failed && hasCopy,
    refreshing: itemsQuery.isRefetching || listQuery.isRefetching,
    refetch,
    weekStart: byList ? (planWeek.data ?? null) : weekStart,
    plan: byList ? undefined : plan.data,
    mealCount,
    list,
    items,
    split,
    progress,
    stale,
    pending: itemsQuery.pendingCount,
    build: {
      run,
      building: buildMutation.isPending,
      error: buildMutation.error ? listErrorMessage(buildMutation.error) : null,
    },
  };
}
