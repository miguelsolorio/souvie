// The replay queue (WS05, risk R6): grocery list writes that survive a dead connection.
//
// In a store the signal comes and goes. A check-off must answer on the tap, must not be lost when
// the app is closed, and must not duplicate or clobber anything when the connection returns. So a
// tap is not a request: it is an operation appended to a queue that is saved on the device. The
// screen shows the server's list with the queued operations laid over it (`overlayOps`), so what
// the person sees is right at once, after a restart, and after a refetch. A runner sends the
// operations one by one when it can. Each is safe to send twice:
//
//   check    an explicit state with the time of the tap (last writer wins by that time, enforced by
//            the database, so a late replay never overwrites a newer toggle)
//   add      a client-made id with ON CONFLICT DO NOTHING
//   patch    only the changed columns, idempotent by nature
//   remove   already gone counts as done
//
// Taps on the same item collapse before they are sent (ten toggles are one write), and removing an
// item cancels everything queued for it that has not started sending. The operation being sent is
// never changed or cancelled: later taps queue behind it. No CRDTs: a check is last-writer-wins, which is enough
// because two people rarely check the same item within seconds (docs/01 §Realtime and offline).
import type { GroceryListItem, ItemPatch, ManualItemInput } from "@mp/core";
import { manualItemRow, withItemChecked, withItemPatched, withoutItem } from "../lists";

// ---------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------

export type ListOp =
  | {
      kind: "check";
      id: string;
      itemId: string;
      checked: boolean;
      userId: string;
      /** When the tap happened on this device, ISO. The database keeps the newest. */
      at: string;
    }
  | {
      kind: "add";
      id: string;
      itemId: string;
      listId: string;
      householdId: string;
      item: ManualItemInput;
      position: number;
    }
  | { kind: "patch"; id: string; itemId: string; patch: ItemPatch }
  | { kind: "remove"; id: string; itemId: string };

/** Adds `next` to the queue, collapsing what it makes redundant. Pure. */
export function coalesceOps(queue: readonly ListOp[], next: ListOp): ListOp[] {
  switch (next.kind) {
    case "check":
      // Only the latest tap on an item matters.
      return [...queue.filter((op) => !(op.kind === "check" && op.itemId === next.itemId)), next];
    case "patch": {
      const index = queue.findLastIndex((op) => op.kind === "patch" && op.itemId === next.itemId);
      const earlier = queue[index];
      if (earlier?.kind !== "patch") return [...queue, next];
      // Later columns win; the merged patch keeps the earlier position in the queue.
      const merged: ListOp = { ...earlier, patch: { ...earlier.patch, ...next.patch } };
      return queue.map((op, i) => (i === index ? merged : op));
    }
    case "remove": {
      const unsent = queue.some((op) => op.kind === "add" && op.itemId === next.itemId);
      const rest = queue.filter((op) => op.itemId !== next.itemId);
      // An item that was never sent leaves no trace; one that exists on the server is deleted.
      return unsent ? rest : [...rest, next];
    }
    case "add":
      return [...queue.filter((op) => !(op.kind === "add" && op.itemId === next.itemId)), next];
  }
}

/** The server's items with the queued operations laid over them, in queue order. Pure. */
export function overlayOps(
  items: readonly GroceryListItem[],
  ops: readonly ListOp[],
  listId?: string | null,
): GroceryListItem[] {
  let result = [...items];
  for (const op of ops) {
    switch (op.kind) {
      case "check":
        result = withItemChecked(result, op);
        break;
      case "patch":
        result = withItemPatched(result, op.itemId, op.patch);
        break;
      case "remove":
        result = withoutItem(result, op.itemId);
        break;
      case "add":
        if (
          (listId === undefined || op.listId === listId) &&
          !result.some((i) => i.id === op.itemId)
        ) {
          result = [
            ...result,
            manualItemRow({
              id: op.itemId,
              listId: op.listId,
              householdId: op.householdId,
              item: op.item,
              position: op.position,
            }),
          ];
        }
        break;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------------------

/** Synchronous key-value storage, as the app's query cache uses (MMKV, localStorage, memory). */
export interface QueueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** How a failed send is handled. */
export type FailureAction = "retry" | "drop";

export interface ReplayQueueOptions {
  /** Where the queue is saved. Without it the queue lives in memory only. */
  storage?: QueueStorage | undefined;
  storageKey: string;
  /** Sends one operation. Throw to fail it; see `classify`. */
  execute: (op: ListOp) => Promise<void>;
  /** Decides whether a failed operation is tried again later or given up on. */
  classify: (error: unknown, op: ListOp) => FailureAction;
  /** Called with an operation that was given up on, so the person can be told. */
  onDrop?: (op: ListOp, error: unknown) => void;
  /** Called after an operation was sent, before it leaves the queue. */
  onSent?: (op: ListOp) => void;
  /** Called when the queue becomes empty after sending something. */
  onIdle?: () => void;
  /** A failed send that is not a network problem is retried this many times, then dropped. */
  maxAttempts?: number;
  /** Retry delay: baseDelayMs doubling per failed run, up to maxDelayMs. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Replace setTimeout, for tests. Returns the function that cancels the timer. */
  schedule?: (run: () => void, delayMs: number) => () => void;
}

const KINDS: ReadonlySet<string> = new Set(["check", "add", "patch", "remove"]);

function parseSaved(raw: string | null): ListOp[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter(
      (op): op is ListOp =>
        typeof op === "object" &&
        op !== null &&
        typeof (op as ListOp).id === "string" &&
        typeof (op as ListOp).itemId === "string" &&
        KINDS.has((op as ListOp).kind),
    );
  } catch {
    return [];
  }
}

export class ReplayQueue {
  private queue: ListOp[];
  private readonly listeners = new Set<() => void>();
  private readonly attempts = new Map<string, number>();
  private running: Promise<void> | null = null;
  /** The operation whose send is in progress. It is immutable until the send settles. */
  private inFlight: ListOp | null = null;
  private cancelRetry: (() => void) | null = null;
  private failedRuns = 0;
  private stopped = false;
  private snapshot: readonly ListOp[];

  constructor(private readonly options: ReplayQueueOptions) {
    let saved: string | null = null;
    try {
      saved = options.storage?.getItem(options.storageKey) ?? null;
    } catch {
      // Storage unavailable (private mode, a corrupt store): start empty rather than crash.
    }
    this.queue = parseSaved(saved);
    this.snapshot = this.queue;
  }

  /** The operations still to send, oldest first. A new array on every change. */
  ops(): readonly ListOp[] {
    return this.snapshot;
  }

  get size(): number {
    return this.queue.length;
  }

  /** For useSyncExternalStore: `subscribe` plus `ops` as the snapshot. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Adds an operation, saves the queue, and tries to send soon. */
  enqueue(op: ListOp): void {
    // The operation being sent is already on its way and cannot be changed or cancelled: whatever
    // is queued now merges only with the operations behind it, or goes after it. (Merging into it
    // would drop the new change when the send finishes and the operation is removed; cancelling
    // against it would leave the server with something the device believes never happened.)
    const head =
      this.inFlight && this.queue[0]?.id === this.inFlight.id ? this.queue[0] : undefined;
    this.queue = head
      ? [head, ...coalesceOps(this.queue.slice(1), op)]
      : coalesceOps(this.queue, op);
    this.changed();
    this.kick();
  }

  /** Tries to send now, ignoring any wait from earlier failures. Safe to call often. */
  kick(): void {
    if (this.stopped || this.queue.length === 0) return;
    this.cancelRetry?.();
    this.cancelRetry = null;
    void this.flush();
  }

  /** Sends operations in order until the queue is empty or the connection fails. One run at a time. */
  flush(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Stops timers. The saved queue stays on the device for the next session. */
  stop(): void {
    this.stopped = true;
    this.cancelRetry?.();
    this.cancelRetry = null;
  }

  private changed(): void {
    this.snapshot = this.queue;
    const { storage, storageKey } = this.options;
    try {
      if (storage) {
        if (this.queue.length === 0) storage.removeItem(storageKey);
        else storage.setItem(storageKey, JSON.stringify(this.queue));
      }
    } catch {
      // Storage full or unavailable: the queue still works in memory for this session.
    }
    for (const listener of this.listeners) listener();
  }

  private remove(op: ListOp): void {
    this.queue = this.queue.filter((queued) => queued.id !== op.id);
    this.attempts.delete(op.id);
    this.changed();
  }

  private async run(): Promise<void> {
    const hadWork = this.queue.length > 0;
    while (!this.stopped) {
      const op = this.queue[0];
      if (!op) break;
      this.inFlight = op;
      try {
        await this.options.execute(op);
      } catch (error) {
        if (this.options.classify(error, op) === "drop") {
          this.options.onDrop?.(op, error);
          this.remove(op);
          continue;
        }
        const tries = (this.attempts.get(op.id) ?? 0) + 1;
        this.attempts.set(op.id, tries);
        const limit = this.options.maxAttempts ?? 8;
        if (tries >= limit && !isNetwork(error)) {
          this.options.onDrop?.(op, error);
          this.remove(op);
          continue;
        }
        this.failedRuns += 1;
        this.scheduleRetry();
        return;
      } finally {
        this.inFlight = null;
      }
      this.options.onSent?.(op);
      this.remove(op);
    }
    this.failedRuns = 0;
    if (hadWork && this.queue.length === 0) this.options.onIdle?.();
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    const base = this.options.baseDelayMs ?? 2000;
    const max = this.options.maxDelayMs ?? 30_000;
    const delay = Math.min(base * 2 ** Math.max(0, this.failedRuns - 1), max);
    const schedule =
      this.options.schedule ??
      ((run: () => void, ms: number) => {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
      });
    this.cancelRetry?.();
    this.cancelRetry = schedule(() => {
      this.cancelRetry = null;
      void this.flush();
    }, delay);
  }
}

function isNetwork(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "network";
}
