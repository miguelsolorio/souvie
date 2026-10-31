import type { GroceryListItem } from "@mp/core";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { groceryItemsKey, groceryListByPlanKey } from "../lists";
import { configureReplayStorage, releaseListQueues } from "../offline/listQueue";
import { fakeClient } from "../testing/fakeClient";
import {
  acquireListChannel,
  applyItemChange,
  LIST_REALTIME_DEBOUNCE_MS,
  listChannelName,
  subscribeListChanges,
} from "./lists";

const HOUSEHOLD = "0a000000-0000-4000-8000-00000000000a";
const OTHER = "0b000000-0000-4000-8000-00000000000b";
const LIST = "1a000000-0000-4000-8000-0000000000a1";
const PLAN = "ca000000-0000-4000-8000-0000000000a1";
const USER = "c3333333-3333-4333-8333-333333333333";
const id = (n: number) => `ea100000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const NOW = "2026-11-01T18:00:00.123456+00:00";

function row(n: number, overrides: Partial<GroceryListItem> = {}): GroceryListItem {
  return {
    id: id(n),
    list_id: LIST,
    household_id: HOUSEHOLD,
    ingredient_id: null,
    display_name: `Item ${n}`,
    qty: 1,
    unit: null,
    source_entry_ids: [],
    section: "produce",
    checked: false,
    checked_by: null,
    checked_at: null,
    excluded_reason: null,
    needs_attention: false,
    is_manual: false,
    position: n,
    qualifiers: [],
    edited: false,
    detail: { contributions: [] },
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function setup() {
  const { client, channels, server } = fakeClient();
  const queryClient = new QueryClient();
  queryClient.setQueryData(groceryItemsKey(HOUSEHOLD, LIST), [row(1), row(2)]);
  queryClient.setQueryData(groceryListByPlanKey(HOUSEHOLD, PLAN), null);
  queryClient.setQueryData(groceryListByPlanKey(OTHER, PLAN), null);
  const stale = (key: readonly unknown[]) => queryClient.getQueryState(key)?.isInvalidated === true;
  const items = () => queryClient.getQueryData<GroceryListItem[]>(groceryItemsKey(HOUSEHOLD, LIST));
  return { client, server, channels, queryClient, stale, items };
}

beforeEach(() => {
  vi.useFakeTimers();
  configureReplayStorage(undefined);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("subscribeListChanges", () => {
  it("listens to the household's items and lists, filtered by household_id", () => {
    const { client, channels, queryClient } = setup();
    subscribeListChanges(client, queryClient, HOUSEHOLD);
    expect(channels).toHaveLength(1);
    expect(channels[0]?.name).toBe(listChannelName(HOUSEHOLD));
    expect(channels[0]?.name).toBe(`list:${HOUSEHOLD}`);
    expect(channels[0]?.handlers.map((h) => [h.type, h.filter])).toEqual([
      [
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "grocery_list_items",
          filter: `household_id=eq.${HOUSEHOLD}`,
        },
      ],
      [
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "grocery_lists",
          filter: `household_id=eq.${HOUSEHOLD}`,
        },
      ],
    ]);
  });

  it("shows another member's check-off at once, from the payload (acceptance criterion 8)", () => {
    const { client, channels, queryClient, items, stale } = setup();
    subscribeListChanges(client, queryClient, HOUSEHOLD);
    channels[0]?.handlers[0]?.callback({
      eventType: "UPDATE",
      new: row(2, { checked: true, checked_by: USER, checked_at: NOW }),
      old: row(2),
    });
    // No timer, no refetch: the cache already holds it.
    expect(items()?.[1]).toMatchObject({ checked: true, checked_by: USER });
    expect(items()?.[0]?.checked).toBe(false);
    expect(stale(groceryItemsKey(HOUSEHOLD, LIST))).toBe(false);
  });

  it("applies remote inserts and deletes", () => {
    const { client, channels, queryClient, items } = setup();
    subscribeListChanges(client, queryClient, HOUSEHOLD);
    const handler = channels[0]?.handlers[0]?.callback;
    handler?.({ eventType: "INSERT", new: row(3, { is_manual: true, display_name: "Candles" }) });
    expect(items()?.map((i) => i.display_name)).toEqual(["Item 1", "Item 2", "Candles"]);
    handler?.({ eventType: "DELETE", old: { id: id(1) } });
    expect(items()?.map((i) => i.display_name)).toEqual(["Item 2", "Candles"]);
  });

  it("refetches when a payload cannot be applied, and collapses a burst into one invalidation", async () => {
    const { client, channels, queryClient, stale } = setup();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    subscribeListChanges(client, queryClient, HOUSEHOLD);
    for (let i = 0; i < 7; i++)
      channels[0]?.handlers[0]?.callback({ eventType: "UPDATE", new: { id: "not a row" } });
    channels[0]?.handlers[1]?.callback({ eventType: "UPDATE" });
    expect(stale(groceryItemsKey(HOUSEHOLD, LIST))).toBe(false); // waits out the debounce
    await vi.advanceTimersByTimeAsync(LIST_REALTIME_DEBOUNCE_MS);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(stale(groceryItemsKey(HOUSEHOLD, LIST))).toBe(true);
    expect(stale(groceryListByPlanKey(HOUSEHOLD, PLAN))).toBe(true);
    expect(stale(groceryListByPlanKey(OTHER, PLAN))).toBe(false);
  });

  it("refetches once on every (re)join, so changes missed while the channel was down arrive", async () => {
    const { client, channels, queryClient, stale } = setup();
    const joined = vi.fn();
    subscribeListChanges(client, queryClient, HOUSEHOLD, { onJoined: joined });
    channels[0]?.statusCallback?.("SUBSCRIBED");
    await vi.advanceTimersByTimeAsync(LIST_REALTIME_DEBOUNCE_MS);
    expect(joined).toHaveBeenCalledTimes(1);
    expect(stale(groceryListByPlanKey(HOUSEHOLD, PLAN))).toBe(true);
  });

  it("stops listening and ignores timers that were pending", async () => {
    const { client, channels, queryClient, stale } = setup();
    const stop = subscribeListChanges(client, queryClient, HOUSEHOLD);
    channels[0]?.handlers[1]?.callback({ eventType: "UPDATE" });
    stop();
    await vi.advanceTimersByTimeAsync(LIST_REALTIME_DEBOUNCE_MS * 2);
    expect(channels[0]?.removed).toBe(true);
    expect(stale(groceryListByPlanKey(HOUSEHOLD, PLAN))).toBe(false);
  });
});

describe("applyItemChange", () => {
  it("returns false for what it cannot apply, and true when there is nothing to patch", () => {
    const { queryClient } = setup();
    expect(applyItemChange(queryClient, HOUSEHOLD, { eventType: "TRUNCATE" })).toBe(false);
    expect(applyItemChange(queryClient, HOUSEHOLD, { eventType: "UPDATE", new: { id: 1 } })).toBe(
      false,
    );
    expect(applyItemChange(queryClient, HOUSEHOLD, { eventType: "DELETE", old: {} })).toBe(false);
    // A list this device never opened: nothing cached, nothing to do, no refetch needed.
    expect(
      applyItemChange(queryClient, HOUSEHOLD, {
        eventType: "UPDATE",
        new: row(1, { list_id: "1c000000-0000-4000-8000-0000000000c1" }),
      }),
    ).toBe(true);
  });

  it("never touches another household's cache", () => {
    const { queryClient } = setup();
    const theirs = [row(1, { household_id: OTHER })];
    queryClient.setQueryData(groceryItemsKey(OTHER, LIST), theirs);
    applyItemChange(queryClient, HOUSEHOLD, { eventType: "DELETE", old: { id: id(1) } });
    expect(queryClient.getQueryData(groceryItemsKey(OTHER, LIST))).toEqual(theirs);
  });
});

describe("acquireListChannel", () => {
  it("shares one channel between screens and closes it when the last one leaves", () => {
    const { client, channels, queryClient } = setup();
    const first = acquireListChannel(client, queryClient, HOUSEHOLD);
    const second = acquireListChannel(client, queryClient, HOUSEHOLD);
    expect(channels).toHaveLength(1);
    first();
    first();
    expect(channels[0]?.removed).toBe(false);
    second();
    expect(channels[0]?.removed).toBe(true);
    const third = acquireListChannel(client, queryClient, HOUSEHOLD);
    expect(channels).toHaveLength(2);
    third();
    releaseListQueues(client);
  });

  it("kicks the replay queue when the channel joins, so an offline trip is sent on reconnect", async () => {
    const { client, server, channels, queryClient } = setup();
    server.tables.grocery_list_items = [row(1) as unknown as Record<string, unknown>];
    const release = acquireListChannel(client, queryClient, HOUSEHOLD);
    // Something waiting from before the channel was up.
    const { acquireListQueue } = await import("../offline/listQueue");
    server.offline = true;
    const queue = acquireListQueue(client, queryClient, HOUSEHOLD);
    queue.enqueue({ kind: "check", id: "a", itemId: id(1), checked: true, userId: USER, at: NOW });
    await queue.flush();
    expect(queue.size).toBe(1);

    server.offline = false;
    channels[0]?.statusCallback?.("SUBSCRIBED");
    await queue.flush();
    expect(queue.size).toBe(0);
    expect(server.tables.grocery_list_items?.[0]).toMatchObject({
      checked: true,
      checked_by: USER,
    });
    release();
    releaseListQueues(client);
  });
});
