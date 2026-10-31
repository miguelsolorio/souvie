import { GroceryListItem } from "@mp/core";
import type { QueryClient } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { MpClient } from "../client";
import { useSupabase } from "../context";
import { useSession } from "../hooks/useSession";
import { groceryListRootKey, withItemAdded, withoutItem } from "../lists";
import { acquireListQueue } from "../offline/listQueue";

// Realtime for the grocery list (WS05). When another member checks an item, adds one, or the list
// is rebuilt, this device sees it within a second or two, with no manual refresh.
//
// How it works: Supabase Realtime streams row changes from Postgres, filtered to this household.
// A change to an item carries the whole new row (Realtime applies Row Level Security to inserts and
// updates), so it is put in the cache directly: no round trip, which keeps a check-off on one phone
// well inside the three seconds the brief asks for. Anything that cannot be applied from the payload
// (a row that fails the schema, a delete of an item the cache does not hold) invalidates
// ['grocery-list', householdId] instead, and a burst collapses into one refetch.
//
// Operations still waiting in this device's replay queue are laid over whatever the cache holds
// (overlayOps), so a remote change never undoes a tap that has not been sent yet.
//
// What the database guarantees (supabase/migrations/*_lists.sql): both tables are in the
// supabase_realtime publication, and grocery_list_items has REPLICA IDENTITY FULL, which lets the
// household_id filter also match deletes (Realtime cannot apply RLS to a delete, and a delete
// payload carries only the primary key).

/** Bursts (a rebuild rewriting thirty rows) collapse into one refetch. */
export const LIST_REALTIME_DEBOUNCE_MS = 150;

export const listChannelName = (householdId: string) => `list:${householdId}`;

export interface ListSubscriptionOptions {
  debounceMs?: number;
  /** Called with each channel status: SUBSCRIBED, CLOSED, CHANNEL_ERROR, TIMED_OUT. */
  onStatus?: (status: string) => void;
  /** Called every time the channel (re)joins, after the first fetch. The app uses it to flush the queue. */
  onJoined?: () => void;
}

/** What a postgres_changes payload carries that we read. */
export interface RowChange {
  eventType?: string;
  new?: unknown;
  old?: unknown;
}

function itemsCaches(queryClient: QueryClient, householdId: string) {
  return queryClient.getQueriesData<GroceryListItem[]>({
    queryKey: groceryListRootKey(householdId),
    predicate: (query) => query.queryKey[query.queryKey.length - 1] === "items",
  });
}

/**
 * Puts one remote item change in the cache. Returns false when the change could not be applied
 * from its payload, so the caller refetches instead.
 */
export function applyItemChange(
  queryClient: QueryClient,
  householdId: string,
  change: RowChange,
): boolean {
  if (change.eventType === "DELETE") {
    const id = (change.old as { id?: unknown } | undefined)?.id;
    if (typeof id !== "string") return false;
    for (const [key, items] of itemsCaches(queryClient, householdId)) {
      if (items?.some((item) => item.id === id)) {
        queryClient.setQueryData<GroceryListItem[]>(key, withoutItem(items, id));
      }
    }
    return true;
  }
  if (change.eventType !== "INSERT" && change.eventType !== "UPDATE") return false;
  const parsed = GroceryListItem.safeParse(change.new);
  if (!parsed.success) return false;
  const row = parsed.data;
  const key = ["grocery-list", householdId, row.list_id, "items"] as const;
  const held = queryClient.getQueryData<GroceryListItem[]>(key);
  // A list this device has not loaded has nothing to patch; opening it fetches fresh.
  if (!held) return true;
  queryClient.setQueryData<GroceryListItem[]>(key, withItemAdded(held, row));
  return true;
}

/**
 * Subscribes to the household's list changes. Returns the function that stops it.
 * Prefer useListRealtime, which shares one channel between the screens that need it.
 */
export function subscribeListChanges(
  client: MpClient,
  queryClient: QueryClient,
  householdId: string,
  options: ListSubscriptionOptions = {},
): () => void {
  const debounceMs = options.debounceMs ?? LIST_REALTIME_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const refresh = () => {
    if (stopped || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (stopped) return;
      void queryClient.invalidateQueries({ queryKey: groceryListRootKey(householdId) });
    }, debounceMs);
  };

  const filter = `household_id=eq.${householdId}`;
  const channel = client
    .channel(listChannelName(householdId))
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "grocery_list_items", filter },
      (payload: RowChange) => {
        if (!applyItemChange(queryClient, householdId, payload)) refresh();
      },
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "grocery_lists", filter },
      refresh,
    )
    .subscribe((status) => {
      options.onStatus?.(status);
      // Changes made while the channel was down, or between the first fetch and the subscription,
      // never arrive as events. Every time the channel (re)joins, fetch fresh data once, and let
      // the app send what it queued while it was offline.
      if (status === "SUBSCRIBED") {
        refresh();
        options.onJoined?.();
      }
    });

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    void client.removeChannel(channel);
  };
}

const shared = new WeakMap<MpClient, Map<string, { users: number; stop: () => void }>>();

/**
 * Like subscribeListChanges, but reference counted: the list screen and store mode can both mount
 * it and still share one channel, which closes when the last one unmounts. Every (re)join also
 * kicks the signed-in person's replay queue for the household, so a check-off made in airplane mode
 * goes out the moment the connection returns. The channel is per person: it kicks that person's
 * queue and nobody else's.
 */
export function acquireListChannel(
  client: MpClient,
  queryClient: QueryClient,
  householdId: string,
  userId: string,
): () => void {
  let byHousehold = shared.get(client);
  if (!byHousehold) {
    byHousehold = new Map();
    shared.set(client, byHousehold);
  }
  const map = byHousehold;
  const key = `${userId}:${householdId}`;
  let entry = map.get(key);
  if (!entry) {
    entry = {
      users: 0,
      stop: subscribeListChanges(client, queryClient, householdId, {
        onJoined: () => acquireListQueue(client, queryClient, { householdId, userId }).kick(),
      }),
    };
    map.set(key, entry);
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
      map.delete(key);
    }
  };
}

/** Keeps the household's grocery list in step with other members' changes while the caller is mounted. */
export function useListRealtime(householdId: string | null | undefined): void {
  const client = useSupabase();
  const queryClient = useQueryClient();
  const { user } = useSession();
  const userId = user?.id;

  useEffect(() => {
    if (!householdId || !userId) return;
    return acquireListChannel(client, queryClient, householdId, userId);
  }, [client, queryClient, householdId, userId]);
}
