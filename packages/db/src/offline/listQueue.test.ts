// The replay queue bound to the supabase-js stand-in (testing/fakeClient.ts): what the database
// ends up with after a store trip with no signal.
import type { GroceryListItem } from "@mp/core";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { groceryItemsKey } from "../lists";
import { type FakeServer, fakeClient } from "../testing/fakeClient";
import {
  acquireListQueue,
  configureReplayStorage,
  createListQueue,
  releaseListQueues,
  replayStorageKey,
  setListWriteFailureHandler,
} from "./listQueue";
import { overlayOps, type QueueStorage } from "./replayQueue";

const USER = "a1111111-1111-4111-8111-111111111111";
const LIST = "1a000000-0000-4000-8000-0000000000a1";
const HOUSEHOLD = "0a000000-0000-4000-8000-00000000000a";
const NOW = "2026-11-01T18:00:00.000Z";
const id = (n: number) => `ea100000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function row(n: number): Record<string, unknown> {
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
  };
}

function memoryStorage(): QueueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

function setup(count = 10) {
  const { client, server } = fakeClient();
  server.tables.grocery_list_items = Array.from({ length: count }, (_, i) => row(i + 1));
  const queryClient = new QueryClient();
  const items = server.tables.grocery_list_items.map((r) => ({
    ...r,
  })) as unknown as GroceryListItem[];
  queryClient.setQueryData(groceryItemsKey(HOUSEHOLD, LIST), items);
  const storage = memoryStorage();
  configureReplayStorage(storage);
  return { client, server, queryClient, storage, items };
}

afterEach(() => {
  configureReplayStorage(undefined);
  setListWriteFailureHandler(undefined);
});

const writes = (server: FakeServer, ok: boolean) =>
  server.requests("grocery_list_items", "update").filter((r) => r.failed === !ok);

describe("a store trip with no signal (acceptance criterion 7)", () => {
  it("queues 10 check-offs offline, then persists each once with checked_by set", async () => {
    const { client, server, queryClient, items } = setup();
    const queue = createListQueue({ client, queryClient, householdId: HOUSEHOLD });
    server.offline = true;

    for (let n = 1; n <= 10; n++) {
      queue.enqueue({
        kind: "check",
        id: `op-${n}`,
        itemId: id(n),
        checked: true,
        userId: USER,
        at: new Date(Date.parse(NOW) + n * 1000).toISOString(),
      });
    }
    await queue.flush();

    // The screen: all ten checked at once, from the queue laid over the server's list.
    const shown = overlayOps(items, queue.ops(), LIST);
    expect(shown.filter((i) => i.checked)).toHaveLength(10);
    // The server: untouched, and the queue is waiting.
    expect(server.tables.grocery_list_items?.some((r) => r.checked === true)).toBe(false);
    expect(queue.size).toBe(10);
    expect(writes(server, true)).toHaveLength(0);

    // Reconnect.
    server.offline = false;
    queue.kick();
    await queue.flush();

    const rows = server.tables.grocery_list_items ?? [];
    expect(rows.filter((r) => r.checked === true)).toHaveLength(10);
    expect(rows.every((r) => r.checked_by === USER)).toBe(true);
    expect(rows.every((r) => typeof r.checked_at === "string")).toBe(true);
    // Ten writes, one per item: no duplicates, nothing sent twice.
    const sent = writes(server, true);
    expect(sent).toHaveLength(10);
    expect(new Set(sent.map((r) => JSON.stringify(r.filters))).size).toBe(10);
    expect(rows).toHaveLength(10);
    expect(queue.size).toBe(0);

    // The cache holds what the server confirmed, so the screen did not flicker when the queue drained.
    const cached = queryClient.getQueryData<GroceryListItem[]>(groceryItemsKey(HOUSEHOLD, LIST));
    expect(cached?.every((i) => i.checked && i.checked_by === USER)).toBe(true);
  });

  it("sends what an earlier session left on the device, and clears it", async () => {
    const { client, server, queryClient, storage } = setup(3);
    const first = createListQueue({ client, queryClient, householdId: HOUSEHOLD });
    server.offline = true;
    first.enqueue({ kind: "check", id: "a", itemId: id(1), checked: true, userId: USER, at: NOW });
    await first.flush();
    first.stop();
    expect(storage.data.get(replayStorageKey(HOUSEHOLD))).toContain(id(1));

    server.offline = false;
    const queue = acquireListQueue(client, queryClient, HOUSEHOLD);
    await queue.flush();
    expect(server.tables.grocery_list_items?.find((r) => r.id === id(1))?.checked).toBe(true);
    expect(storage.data.has(replayStorageKey(HOUSEHOLD))).toBe(false);
    releaseListQueues(client);
  });

  it("a manual add whose answer was lost is sent again with the same id and stays one row", async () => {
    const { client, server, queryClient } = setup(2);
    const queue = createListQueue({ client, queryClient, householdId: HOUSEHOLD });
    // The first send is applied by the server but the response never arrives.
    server.failures = [{ message: "Failed to fetch", status: 0, afterApply: true }];
    queue.enqueue({
      kind: "add",
      id: "op-add",
      itemId: id(50),
      listId: LIST,
      householdId: HOUSEHOLD,
      item: { display_name: "Birthday candles", qty: 1 },
      position: 9,
    });
    await queue.flush();
    expect(queue.size).toBe(1);
    expect(server.tables.grocery_list_items?.filter((r) => r.id === id(50))).toHaveLength(1);

    queue.kick();
    await queue.flush();
    expect(queue.size).toBe(0);
    const added = server.tables.grocery_list_items?.filter(
      (r) => r.display_name === "Birthday candles",
    );
    expect(added).toHaveLength(1);
    expect(added?.[0]).toMatchObject({
      is_manual: true,
      list_id: LIST,
      household_id: HOUSEHOLD,
      section: "other",
    });
    expect(server.requests("grocery_list_items", "upsert")).toHaveLength(2);
    expect(server.requests("grocery_list_items", "upsert")[0]?.options).toMatchObject({
      onConflict: "id",
      ignoreDuplicates: true,
    });
  });

  it("sends an edit as a patch that marks the item edited, and a delete as a delete", async () => {
    const { client, server, queryClient } = setup(3);
    const queue = createListQueue({ client, queryClient, householdId: HOUSEHOLD });
    queue.enqueue({ kind: "patch", id: "p", itemId: id(1), patch: { qty: 4, unit: "lb" } });
    queue.enqueue({ kind: "patch", id: "q", itemId: id(2), patch: { excluded_reason: "manual" } });
    queue.enqueue({ kind: "remove", id: "r", itemId: id(3) });
    await queue.flush();
    const rows = server.tables.grocery_list_items ?? [];
    expect(rows.find((r) => r.id === id(1))).toMatchObject({ qty: 4, unit: "lb", edited: true });
    expect(rows.find((r) => r.id === id(2))).toMatchObject({
      excluded_reason: "manual",
      edited: false,
    });
    expect(rows.some((r) => r.id === id(3))).toBe(false);
  });

  it("drops a write the server refuses, tells the app, and leaves the rest going", async () => {
    const { client, server, queryClient } = setup(3);
    const dropped: string[] = [];
    setListWriteFailureHandler((op) => dropped.push(op.itemId));
    const queue = createListQueue({ client, queryClient, householdId: HOUSEHOLD });
    server.failures = [{ message: "checked_by_mismatch", code: "42501", status: 403 }];
    queue.enqueue({ kind: "check", id: "a", itemId: id(1), checked: true, userId: USER, at: NOW });
    queue.enqueue({ kind: "check", id: "b", itemId: id(2), checked: true, userId: USER, at: NOW });
    await queue.flush();
    expect(dropped).toEqual([id(1)]);
    expect(queue.size).toBe(0);
    const rows = server.tables.grocery_list_items ?? [];
    expect(rows.find((r) => r.id === id(1))?.checked).toBe(false);
    expect(rows.find((r) => r.id === id(2))?.checked).toBe(true);
  });

  it("treats a check on an item a rebuild removed as done", async () => {
    const { client, server, queryClient } = setup(2);
    server.tables.grocery_list_items = (server.tables.grocery_list_items ?? []).filter(
      (r) => r.id !== id(1),
    );
    const queue = createListQueue({ client, queryClient, householdId: HOUSEHOLD });
    queue.enqueue({ kind: "check", id: "a", itemId: id(1), checked: true, userId: USER, at: NOW });
    await queue.flush();
    expect(queue.size).toBe(0);
  });
});
