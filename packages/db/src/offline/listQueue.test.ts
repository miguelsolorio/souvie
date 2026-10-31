// The replay queue bound to the supabase-js stand-in (testing/fakeClient.ts): what the database
// ends up with after a store trip with no signal.
import type { GroceryListItem } from "@mp/core";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { groceryItemsKey } from "../lists";
import { type FakeServer, fakeClient } from "../testing/fakeClient";
import {
  acquireListQueue,
  configureReplayStorage,
  createListQueue,
  releaseListQueue,
  releaseListQueues,
  replayStorageKey,
  setListWriteFailureHandler,
  startListSync,
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
    const queue = createListQueue({ client, queryClient, householdId: HOUSEHOLD, userId: USER });
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
    const first = createListQueue({ client, queryClient, householdId: HOUSEHOLD, userId: USER });
    server.offline = true;
    first.enqueue({ kind: "check", id: "a", itemId: id(1), checked: true, userId: USER, at: NOW });
    await first.flush();
    first.stop();
    expect(storage.data.get(replayStorageKey(USER, HOUSEHOLD))).toContain(id(1));

    server.offline = false;
    const queue = acquireListQueue(client, queryClient, { householdId: HOUSEHOLD, userId: USER });
    await queue.flush();
    expect(server.tables.grocery_list_items?.find((r) => r.id === id(1))?.checked).toBe(true);
    expect(storage.data.has(replayStorageKey(USER, HOUSEHOLD))).toBe(false);
    releaseListQueues(client);
  });

  it("a manual add whose answer was lost is sent again with the same id and stays one row", async () => {
    const { client, server, queryClient } = setup(2);
    const queue = createListQueue({ client, queryClient, householdId: HOUSEHOLD, userId: USER });
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
    const queue = createListQueue({ client, queryClient, householdId: HOUSEHOLD, userId: USER });
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
    const queue = createListQueue({ client, queryClient, householdId: HOUSEHOLD, userId: USER });
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
    const queue = createListQueue({ client, queryClient, householdId: HOUSEHOLD, userId: USER });
    queue.enqueue({ kind: "check", id: "a", itemId: id(1), checked: true, userId: USER, at: NOW });
    await queue.flush();
    expect(queue.size).toBe(0);
  });
});

describe("whose queue it is (F4)", () => {
  const BOB = "b2222222-2222-4222-8222-222222222222";
  const OTHER_HOUSEHOLD = "0b000000-0000-4000-8000-00000000000b";
  const sentCount = (server: FakeServer) => writes(server, true).length;

  /** The user's operations, queued on a phone with no signal and left there (they signed out). */
  async function parkAlicesChecks(count = 3) {
    const ctx = setup(count);
    ctx.server.offline = true;
    const queue = acquireListQueue(ctx.client, ctx.queryClient, {
      householdId: HOUSEHOLD,
      userId: USER,
    });
    for (let n = 1; n <= count; n++) {
      queue.enqueue({
        kind: "check",
        id: `a${n}`,
        itemId: id(n),
        checked: true,
        userId: USER,
        at: NOW,
      });
    }
    await queue.flush();
    ctx.server.offline = false;
    // Sign-out: the loop stops and the in-memory queues go. The saved operations stay.
    releaseListQueues(ctx.client);
    return ctx;
  }

  it("saves a queue under the user and the household, so two people on one phone never share one", () => {
    const alice = replayStorageKey(USER, HOUSEHOLD);
    expect(alice).toContain(USER);
    expect(alice).toContain(HOUSEHOLD);
    expect(replayStorageKey(BOB, HOUSEHOLD)).not.toBe(alice);
    expect(replayStorageKey(USER, OTHER_HOUSEHOLD)).not.toBe(alice);
  });

  it("sends none of Alice's operations when Bob signs in, and keeps them for Alice", async () => {
    const { client, server, queryClient, storage } = await parkAlicesChecks();
    expect(storage.data.get(replayStorageKey(USER, HOUSEHOLD))).toContain(id(1));

    // Bob signs in on the same phone, in the same household.
    const bob = startListSync(client, queryClient, { householdId: HOUSEHOLD, userId: BOB });
    const bobsQueue = acquireListQueue(client, queryClient, {
      householdId: HOUSEHOLD,
      userId: BOB,
    });
    await bobsQueue.flush();
    bob();
    expect(bobsQueue.size).toBe(0);
    expect(sentCount(server)).toBe(0);
    expect(server.tables.grocery_list_items?.some((r) => r.checked === true)).toBe(false);
    // Alice's operations are parked under her key, untouched.
    const parked = JSON.parse(storage.data.get(replayStorageKey(USER, HOUSEHOLD)) ?? "[]");
    expect(parked).toHaveLength(3);
    expect(storage.data.has(replayStorageKey(BOB, HOUSEHOLD))).toBe(false);
  });

  it("replays Alice's operations, as hers, when she signs back in", async () => {
    const { client, server, queryClient, storage } = await parkAlicesChecks();
    const bob = startListSync(client, queryClient, { householdId: HOUSEHOLD, userId: BOB });
    bob();
    releaseListQueues(client);

    const alice = startListSync(client, queryClient, { householdId: HOUSEHOLD, userId: USER });
    await acquireListQueue(client, queryClient, { householdId: HOUSEHOLD, userId: USER }).flush();
    alice();
    const rows = server.tables.grocery_list_items ?? [];
    expect(rows.filter((r) => r.checked === true)).toHaveLength(3);
    expect(rows.filter((r) => r.checked === true).every((r) => r.checked_by === USER)).toBe(true);
    expect(sentCount(server)).toBe(3);
    expect(storage.data.has(replayStorageKey(USER, HOUSEHOLD))).toBe(false);
  });

  it("does not send another household's operations under the active household's session", async () => {
    const ctx = setup(3);
    ctx.server.offline = true;
    const elsewhere = acquireListQueue(ctx.client, ctx.queryClient, {
      householdId: OTHER_HOUSEHOLD,
      userId: USER,
    });
    elsewhere.enqueue({
      kind: "check",
      id: "x",
      itemId: id(1),
      checked: true,
      userId: USER,
      at: NOW,
    });
    await elsewhere.flush();
    ctx.server.offline = false;
    releaseListQueues(ctx.client);

    // The same person is now acting in the first household: only its queue runs.
    const stop = startListSync(ctx.client, ctx.queryClient, {
      householdId: HOUSEHOLD,
      userId: USER,
    });
    await acquireListQueue(ctx.client, ctx.queryClient, {
      householdId: HOUSEHOLD,
      userId: USER,
    }).flush();
    stop();
    expect(sentCount(ctx.server)).toBe(0);
    expect(ctx.storage.data.has(replayStorageKey(USER, OTHER_HOUSEHOLD))).toBe(true);
  });

  describe("signing out", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("stops the retry timer and sends nothing more", async () => {
      const { client, server, queryClient, storage } = setup(2);
      server.offline = true;
      const stop = startListSync(client, queryClient, { householdId: HOUSEHOLD, userId: USER });
      const queue = acquireListQueue(client, queryClient, { householdId: HOUSEHOLD, userId: USER });
      queue.enqueue({
        kind: "check",
        id: "a",
        itemId: id(1),
        checked: true,
        userId: USER,
        at: NOW,
      });
      await vi.advanceTimersByTimeAsync(100);
      const attempts = server.requests("grocery_list_items", "update").length;
      expect(attempts).toBeGreaterThanOrEqual(1);
      expect(vi.getTimerCount()).toBeGreaterThan(0); // the backoff retry

      stop(); // sign-out
      expect(vi.getTimerCount()).toBe(0);
      server.offline = false;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(server.requests("grocery_list_items", "update")).toHaveLength(attempts);
      // The operation is still on the device for the next time this person signs in.
      expect(storage.data.get(replayStorageKey(USER, HOUSEHOLD))).toContain(id(1));
    });

    it("a queue asked for after sign-out is a fresh one that works, not the stopped one", async () => {
      const { client, server, queryClient } = setup(2);
      const first = acquireListQueue(client, queryClient, { householdId: HOUSEHOLD, userId: USER });
      releaseListQueue(client, { householdId: HOUSEHOLD, userId: USER });
      const second = acquireListQueue(client, queryClient, {
        householdId: HOUSEHOLD,
        userId: USER,
      });
      expect(second).not.toBe(first);
      second.enqueue({
        kind: "check",
        id: "a",
        itemId: id(1),
        checked: true,
        userId: USER,
        at: NOW,
      });
      await vi.advanceTimersByTimeAsync(500);
      expect(server.tables.grocery_list_items?.find((r) => r.id === id(1))?.checked).toBe(true);
    });
  });
});
