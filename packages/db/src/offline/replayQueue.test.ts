import type { GroceryListItem } from "@mp/core";
import { describe, expect, it, vi } from "vitest";
import { ListError } from "../lists";
import { classifyListError } from "./listQueue";
import {
  coalesceOps,
  type ListOp,
  overlayOps,
  type QueueStorage,
  ReplayQueue,
  type ReplayQueueOptions,
} from "./replayQueue";

const USER = "a1111111-1111-4111-8111-111111111111";
const LIST = "1a000000-0000-4000-8000-0000000000a1";
const HOUSEHOLD = "0a000000-0000-4000-8000-00000000000a";
const NOW = "2026-11-01T18:00:00.000Z";

const itemId = (n: number) => `ea100000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function item(n: number, overrides: Partial<GroceryListItem> = {}): GroceryListItem {
  return {
    id: itemId(n),
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

let opCounter = 0;
const check = (n: number, checked: boolean, at = NOW): ListOp => ({
  kind: "check",
  id: `op-${++opCounter}`,
  itemId: itemId(n),
  checked,
  userId: USER,
  at,
});
const patch = (n: number, columns: Extract<ListOp, { kind: "patch" }>["patch"]): ListOp => ({
  kind: "patch",
  id: `op-${++opCounter}`,
  itemId: itemId(n),
  patch: columns,
});
const add = (n: number, name = "Paper towels"): ListOp => ({
  kind: "add",
  id: `op-${++opCounter}`,
  itemId: itemId(n),
  listId: LIST,
  householdId: HOUSEHOLD,
  item: { display_name: name },
  position: n,
});
const remove = (n: number): ListOp => ({
  kind: "remove",
  id: `op-${++opCounter}`,
  itemId: itemId(n),
});

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

/** A queue whose retries run when the test says so instead of on a timer. */
function makeQueue(overrides: Partial<ReplayQueueOptions> = {}) {
  const timers: Array<{ run: () => void; delayMs: number; cancelled: boolean }> = [];
  const sent: ListOp[] = [];
  const options: ReplayQueueOptions = {
    storageKey: "queue",
    execute: async (op) => {
      sent.push(op);
    },
    classify: classifyListError,
    schedule: (run, delayMs) => {
      const timer = { run, delayMs, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    ...overrides,
  };
  const queue = new ReplayQueue(options);
  return { queue, sent, timers };
}

const offline = () => new ListError("network", "Failed to fetch");

describe("coalesceOps", () => {
  it("keeps only the latest tap on an item", () => {
    let queue: ListOp[] = [];
    queue = coalesceOps(queue, check(1, true, "2026-11-01T18:00:01.000Z"));
    queue = coalesceOps(queue, check(2, true));
    queue = coalesceOps(queue, check(1, false, "2026-11-01T18:00:03.000Z"));
    queue = coalesceOps(queue, check(1, true, "2026-11-01T18:00:05.000Z"));
    expect(queue.map((op) => op.kind === "check" && [op.itemId, op.checked])).toEqual([
      [itemId(2), true],
      [itemId(1), true],
    ]);
  });

  it("merges edits of one item and lets later columns win", () => {
    let queue: ListOp[] = [];
    queue = coalesceOps(queue, patch(1, { qty: 2 }));
    queue = coalesceOps(queue, patch(2, { qty: 9 }));
    queue = coalesceOps(queue, patch(1, { qty: 3, unit: "lb" }));
    expect(queue).toHaveLength(2);
    expect(queue[0]).toMatchObject({ itemId: itemId(1), patch: { qty: 3, unit: "lb" } });
  });

  it("removing an item that was never sent leaves nothing behind", () => {
    let queue: ListOp[] = [];
    queue = coalesceOps(queue, add(7));
    queue = coalesceOps(queue, check(7, true));
    queue = coalesceOps(queue, remove(7));
    expect(queue).toEqual([]);
  });

  it("removing an item that exists cancels its queued taps and keeps the delete", () => {
    let queue: ListOp[] = [];
    queue = coalesceOps(queue, check(1, true));
    queue = coalesceOps(queue, patch(1, { qty: 2 }));
    queue = coalesceOps(queue, remove(1));
    expect(queue.map((op) => op.kind)).toEqual(["remove"]);
  });

  it("an item added twice with the same id is one add", () => {
    let queue: ListOp[] = [];
    queue = coalesceOps(queue, add(7, "Candles"));
    queue = coalesceOps(queue, add(7, "Birthday candles"));
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ item: { display_name: "Birthday candles" } });
  });

  it("does not change the queue it was given", () => {
    const queue: ListOp[] = [check(1, true)];
    const before = JSON.stringify(queue);
    coalesceOps(queue, check(1, false));
    expect(JSON.stringify(queue)).toBe(before);
  });
});

describe("overlayOps", () => {
  const items = [item(1), item(2), item(3, { checked: true, checked_by: USER })];

  it("shows queued check-offs on top of the server's list", () => {
    const shown = overlayOps(items, [check(1, true), check(3, false)]);
    expect(shown.map((i) => i.checked)).toEqual([true, false, false]);
    expect(shown[0]?.checked_by).toBe(USER);
    expect(items[0]?.checked).toBe(false);
  });

  it("shows queued edits, adds and removes", () => {
    const shown = overlayOps(items, [patch(2, { qty: 4 }), add(9, "Candles"), remove(1)], LIST);
    expect(shown.map((i) => i.display_name)).toEqual(["Item 2", "Item 3", "Candles"]);
    expect(shown[0]).toMatchObject({ qty: 4, edited: true });
    expect(shown[2]).toMatchObject({ is_manual: true, list_id: LIST });
  });

  it("puts an add on its own list only, and never twice", () => {
    expect(overlayOps(items, [add(9)], "another-list")).toHaveLength(3);
    const once = overlayOps([...items, item(9, { is_manual: true })], [add(9)], LIST);
    expect(once.filter((i) => i.id === itemId(9))).toHaveLength(1);
  });

  it("is the server's list when nothing is queued", () => {
    expect(overlayOps(items, [])).toEqual(items);
  });
});

describe("airplane mode (acceptance criterion 7)", () => {
  it("shows 10 check-offs at once, keeps them, and sends each exactly once on reconnect", async () => {
    const storage = memoryStorage();
    let online = false;
    const delivered: string[] = [];
    const { queue, timers } = makeQueue({
      storage,
      execute: async (op) => {
        if (!online) throw offline();
        if (op.kind === "check") delivered.push(`${op.itemId}:${op.checked}:${op.userId}`);
      },
    });
    const items = Array.from({ length: 10 }, (_, i) => item(i + 1));

    // Ten taps with no connection. The screen answers on each one (overlay), nothing is sent.
    for (let n = 1; n <= 10; n++) queue.enqueue(check(n, true));
    await queue.flush();
    expect(queue.size).toBe(10);
    expect(delivered).toEqual([]);
    expect(overlayOps(items, queue.ops()).every((i) => i.checked && i.checked_by === USER)).toBe(
      true,
    );
    expect(timers.filter((t) => !t.cancelled).length).toBeGreaterThan(0);

    // The app is killed and reopened: the taps are still there.
    const reopened = makeQueue({
      storage,
      execute: async (op) => {
        if (!online) throw offline();
        if (op.kind === "check") delivered.push(`${op.itemId}:${op.checked}:${op.userId}`);
      },
    });
    expect(reopened.queue.size).toBe(10);
    expect(overlayOps(items, reopened.queue.ops()).filter((i) => i.checked)).toHaveLength(10);

    // The connection returns.
    online = true;
    reopened.queue.kick();
    await reopened.queue.flush();
    expect(reopened.queue.size).toBe(0);
    expect(delivered).toEqual(
      Array.from({ length: 10 }, (_, i) => `${itemId(i + 1)}:true:${USER}`),
    );
    expect(new Set(delivered).size).toBe(10);
    expect(storage.data.has("queue")).toBe(false);
  });

  it("stops at the first dead connection and resumes there, never resending what went out", async () => {
    const delivered: string[] = [];
    let failAt = 4;
    const { queue, timers } = makeQueue({
      execute: async (op) => {
        if (delivered.length === failAt) throw offline();
        delivered.push(op.itemId);
      },
    });
    for (let n = 1; n <= 6; n++) queue.enqueue(check(n, true));
    await queue.flush();
    expect(delivered).toHaveLength(4);
    expect(queue.size).toBe(2);

    failAt = 99;
    const retry = timers.filter((t) => !t.cancelled).at(-1);
    expect(retry).toBeDefined();
    retry?.run();
    await queue.flush();
    expect(delivered).toEqual([1, 2, 3, 4, 5, 6].map(itemId));
    expect(queue.size).toBe(0);
  });

  it("collapses many toggles of one item: the one being sent, and the newest behind it", async () => {
    const { queue, sent } = makeQueue({
      execute: async () => {
        throw offline();
      },
    });
    for (let i = 0; i < 7; i++) queue.enqueue(check(1, i % 2 === 0, `2026-11-01T18:00:0${i}.000Z`));
    // The first tap is already on its way and is left alone; the six after it collapse to the last.
    expect(queue.size).toBe(2);
    expect(queue.ops()[0]).toMatchObject({ checked: true, at: "2026-11-01T18:00:00.000Z" });
    expect(queue.ops()[1]).toMatchObject({ checked: true, at: "2026-11-01T18:00:06.000Z" });
    expect(sent).toEqual([]);
  });
});

describe("failures", () => {
  it("backs off between retries, doubling up to a limit, and starts over after a success", async () => {
    let online = false;
    const { queue, timers } = makeQueue({
      baseDelayMs: 1000,
      maxDelayMs: 5000,
      execute: async () => {
        if (!online) throw offline();
      },
    });
    queue.enqueue(check(1, true));
    await queue.flush();
    for (let i = 0; i < 4; i++) {
      const last = timers.filter((t) => !t.cancelled).at(-1);
      last?.run();
      await queue.flush();
    }
    expect(timers.map((t) => t.delayMs).slice(0, 5)).toEqual([1000, 2000, 4000, 5000, 5000]);
    online = true;
    queue.kick();
    await queue.flush();
    expect(queue.size).toBe(0);
    online = false;
    queue.enqueue(check(2, true));
    await queue.flush();
    expect(timers.at(-1)?.delayMs).toBe(1000);
  });

  it("gives up on an operation the server refuses, tells the app, and carries on", async () => {
    const onDrop = vi.fn();
    const delivered: string[] = [];
    const { queue } = makeQueue({
      onDrop,
      execute: async (op) => {
        if (op.itemId === itemId(2)) throw new ListError("forbidden", "checked_by_mismatch");
        delivered.push(op.itemId);
      },
    });
    for (let n = 1; n <= 3; n++) queue.enqueue(check(n, true));
    await queue.flush();
    expect(delivered).toEqual([itemId(1), itemId(3)]);
    expect(queue.size).toBe(0);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop.mock.calls[0]?.[0]).toMatchObject({ itemId: itemId(2) });
  });

  it("drops an operation that keeps failing for a reason other than the network, after a limit", async () => {
    const onDrop = vi.fn();
    const { queue, timers } = makeQueue({
      maxAttempts: 3,
      onDrop,
      execute: async () => {
        throw new ListError("unknown", "boom");
      },
    });
    queue.enqueue(check(1, true));
    await queue.flush();
    for (let i = 0; i < 2; i++) {
      timers
        .filter((t) => !t.cancelled)
        .at(-1)
        ?.run();
      await queue.flush();
    }
    expect(queue.size).toBe(0);
    expect(onDrop).toHaveBeenCalledTimes(1);
  });

  it("never gives up on a dead connection, however long it lasts", async () => {
    const onDrop = vi.fn();
    const { queue, timers } = makeQueue({
      maxAttempts: 2,
      onDrop,
      execute: async () => {
        throw offline();
      },
    });
    queue.enqueue(check(1, true));
    await queue.flush();
    for (let i = 0; i < 6; i++) {
      timers
        .filter((t) => !t.cancelled)
        .at(-1)
        ?.run();
      await queue.flush();
    }
    expect(queue.size).toBe(1);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("sends one run at a time, even when asked twice", async () => {
    let inFlight = 0;
    let peak = 0;
    const { queue } = makeQueue({
      execute: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
      },
    });
    queue.enqueue(check(1, true));
    queue.enqueue(check(2, true));
    void queue.flush();
    void queue.flush();
    queue.kick();
    await queue.flush();
    expect(peak).toBe(1);
    expect(queue.size).toBe(0);
  });

  it("calls onIdle once when it empties, not when there was nothing to send", async () => {
    const onIdle = vi.fn();
    const { queue } = makeQueue({ onIdle });
    await queue.flush();
    expect(onIdle).not.toHaveBeenCalled();
    queue.enqueue(check(1, true));
    queue.enqueue(check(2, true));
    await queue.flush();
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("works in memory when the device storage throws", async () => {
    const storage: QueueStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("full");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    const { queue, sent } = makeQueue({ storage });
    queue.enqueue(check(1, true));
    await queue.flush();
    expect(sent).toHaveLength(1);
  });

  it("ignores a saved queue that is not a queue", () => {
    const storage = memoryStorage();
    storage.data.set("queue", "{not json");
    expect(makeQueue({ storage }).queue.size).toBe(0);
    storage.data.set("queue", JSON.stringify([{ kind: "mystery", id: "x", itemId: "y" }, 7, null]));
    expect(makeQueue({ storage }).queue.size).toBe(0);
    storage.data.set("queue", JSON.stringify([check(1, true)]));
    expect(makeQueue({ storage }).queue.size).toBe(1);
  });

  it("does nothing after it is stopped", async () => {
    const { queue, sent } = makeQueue();
    queue.stop();
    queue.enqueue(check(1, true));
    await queue.flush();
    expect(sent).toEqual([]);
    expect(queue.size).toBe(1);
  });
});

describe("operations made while the head operation is being sent (F3)", () => {
  /** A queue whose first send waits until the test releases it. */
  function holdFirst() {
    const sent: ListOp[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { queue } = makeQueue({
      execute: async (op) => {
        sent.push(op);
        if (sent.length === 1) await gate;
      },
    });
    return { queue, sent, release };
  }

  it("a second edit of the same item reaches the server, not just the first", async () => {
    const { queue, sent, release } = holdFirst();
    queue.enqueue(patch(1, { qty: 2 }));
    queue.enqueue(patch(1, { unit: "lb" }));
    release();
    await queue.flush();
    const columns: Record<string, unknown> = {};
    for (const op of sent) if (op.kind === "patch") Object.assign(columns, op.patch);
    expect(columns).toEqual({ qty: 2, unit: "lb" });
    expect(queue.size).toBe(0);
  });

  it("deleting a manual item whose add is being sent still deletes it on the server", async () => {
    const { queue, sent, release } = holdFirst();
    queue.enqueue(add(2, "Mistake"));
    queue.enqueue(remove(2));
    release();
    await queue.flush();
    expect(sent.map((op) => op.kind)).toEqual(["add", "remove"]);
    expect(queue.size).toBe(0);
  });

  it("a check tapped again while the first is being sent sends both, newest last", async () => {
    const { queue, sent, release } = holdFirst();
    queue.enqueue(check(3, true, "2026-11-01T12:00:01.000Z"));
    queue.enqueue(check(3, false, "2026-11-01T12:00:02.000Z"));
    release();
    await queue.flush();
    const states = sent.filter((op) => op.kind === "check").map((op) => op.checked);
    expect(states).toEqual([true, false]);
    expect(queue.size).toBe(0);
  });

  it("the operation being sent is not changed, and later ones still collapse behind it", async () => {
    const { queue, sent, release } = holdFirst();
    queue.enqueue(patch(1, { qty: 2 }));
    const inFlight = queue.ops()[0];
    queue.enqueue(patch(1, { unit: "lb" }));
    queue.enqueue(patch(1, { section: "meat" }));
    expect(queue.ops()[0]).toBe(inFlight);
    expect(queue.size).toBe(2); // the one in flight, and one merged edit behind it
    release();
    await queue.flush();
    expect(sent.map((op) => (op.kind === "patch" ? op.patch : null))).toEqual([
      { qty: 2 },
      { unit: "lb", section: "meat" },
    ]);
  });

  it("an operation that failed and is waiting to be retried can be merged into again", async () => {
    let online = false;
    const sent: ListOp[] = [];
    const { queue } = makeQueue({
      execute: async (op) => {
        if (!online) throw offline();
        sent.push(op);
      },
    });
    queue.enqueue(patch(1, { qty: 2 }));
    await queue.flush();
    queue.enqueue(patch(1, { unit: "lb" }));
    expect(queue.size).toBe(1);
    await queue.flush(); // the retry that enqueue started fails too, and settles
    online = true;
    queue.kick();
    await queue.flush();
    expect(sent.map((op) => (op.kind === "patch" ? op.patch : null))).toEqual([
      { qty: 2, unit: "lb" },
    ]);
  });
});

describe("classifyListError", () => {
  it("retries a bad connection and an unknown fault, and drops what the server refused", () => {
    expect(classifyListError(new ListError("network"))).toBe("retry");
    expect(classifyListError(new ListError("unknown"))).toBe("retry");
    expect(classifyListError(new Error("surprise"))).toBe("retry");
    for (const code of ["forbidden", "invalid", "not_found", "conflict", "no_plan"] as const) {
      expect(classifyListError(new ListError(code))).toBe("drop");
    }
  });
});
