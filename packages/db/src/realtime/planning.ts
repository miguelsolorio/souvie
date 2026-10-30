import type { QueryClient } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { MpClient } from "../client";
import { useSupabase } from "../context";
import { mealPlanRootKey } from "../planning";

// Realtime for the planner (WS04). When another member adds, edits, or removes an entry, this
// device refetches the plan within a second or two, with no manual refresh.
//
// How it works: Supabase Realtime streams row changes from Postgres. We ask for every change to
// meal_plan_entries and meal_plans in this household and, instead of patching the cache from the
// payload, invalidate ['meal-plan', householdId]. The screens then refetch what they show. That
// keeps one code path for "fresh data" and means the payload never has to carry a whole row.
//
// What the database guarantees (supabase/migrations/*_planning.sql): both tables are in the
// supabase_realtime publication; Realtime applies Row Level Security to inserts and updates, so a
// member receives only their household's changes; and meal_plan_entries has REPLICA IDENTITY FULL,
// which lets the household_id filter also match deletes (Realtime cannot apply RLS to a delete,
// and a delete payload carries only the primary key).

/** Bursts (a draft week of seven entries) collapse into one refetch. */
export const PLAN_REALTIME_DEBOUNCE_MS = 150;

export const planChannelName = (householdId: string) => `plan:${householdId}`;

export interface PlanSubscriptionOptions {
  debounceMs?: number;
  /** Called with each channel status: SUBSCRIBED, CLOSED, CHANNEL_ERROR, TIMED_OUT. */
  onStatus?: (status: string) => void;
}

/**
 * Subscribes to the household's planner changes. Returns the function that stops it.
 * Prefer usePlanRealtime, which shares one channel between the screens that need it.
 */
export function subscribePlanChanges(
  client: MpClient,
  queryClient: QueryClient,
  householdId: string,
  options: PlanSubscriptionOptions = {},
): () => void {
  const debounceMs = options.debounceMs ?? PLAN_REALTIME_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const refresh = () => {
    if (stopped || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!stopped) void queryClient.invalidateQueries({ queryKey: mealPlanRootKey(householdId) });
    }, debounceMs);
  };

  const filter = `household_id=eq.${householdId}`;
  const channel = client
    .channel(planChannelName(householdId))
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "meal_plan_entries", filter },
      refresh,
    )
    .on("postgres_changes", { event: "*", schema: "public", table: "meal_plans", filter }, refresh)
    .subscribe((status) => {
      options.onStatus?.(status);
      // Changes made while the channel was down, or between the first fetch and the subscription,
      // never arrive as events. Every time the channel (re)joins, fetch fresh data once.
      if (status === "SUBSCRIBED") refresh();
    });

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    void client.removeChannel(channel);
  };
}

const shared = new WeakMap<MpClient, Map<string, { users: number; stop: () => void }>>();

/**
 * Like subscribePlanChanges, but reference counted: the week view and the day screen can both
 * mount it and still share one channel, which closes when the last one unmounts.
 */
export function acquirePlanChannel(
  client: MpClient,
  queryClient: QueryClient,
  householdId: string,
): () => void {
  let byHousehold = shared.get(client);
  if (!byHousehold) {
    byHousehold = new Map();
    shared.set(client, byHousehold);
  }
  const map = byHousehold;
  let entry = map.get(householdId);
  if (!entry) {
    entry = { users: 0, stop: subscribePlanChanges(client, queryClient, householdId) };
    map.set(householdId, entry);
  }
  entry.users += 1;
  const held = entry;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.users -= 1;
    if (held.users === 0) {
      held.stop();
      map.delete(householdId);
    }
  };
}

/** Keeps the planner's queries in step with other members' changes while the caller is mounted. */
export function usePlanRealtime(householdId: string | null | undefined): void {
  const client = useSupabase();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!householdId) return;
    return acquirePlanChannel(client, queryClient, householdId);
  }, [client, queryClient, householdId]);
}
