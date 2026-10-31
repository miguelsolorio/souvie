// Binds the replay queue (./replayQueue.ts) to Supabase and the TanStack cache: one queue per
// household per client, saved on the device, sending grocery list writes when it can. The hooks in
// ../hooks/useToggleItem.ts and useAddManualItem.ts enqueue; this file sends.
import type { GroceryListItem } from "@mp/core";
import type { QueryClient } from "@tanstack/react-query";
import type { MpClient } from "../client";
import {
  groceryListRootKey,
  insertManualItem,
  invalidateGroceryList,
  ListError,
  manualItemRow,
  patchItem,
  removeManualItem,
  withItemAdded,
  withItemChecked,
  withItemPatched,
  withoutItem,
  writeItemChecked,
} from "../lists";
import {
  type FailureAction,
  type ListOp,
  type QueueStorage,
  ReplayQueue,
  type ReplayQueueOptions,
} from "./replayQueue";

let storage: QueueStorage | undefined;
let onWriteFailed: ((op: ListOp, error: unknown) => void) | undefined;

/** Where queues are saved on the device. Call once at startup with the app's key-value storage. */
export function configureReplayStorage(next: QueueStorage | undefined): void {
  storage = next;
}

/** Called with an operation the queue gave up on (the server refused it), so the app can say so. */
export function setListWriteFailureHandler(
  handler: ((op: ListOp, error: unknown) => void) | undefined,
): void {
  onWriteFailed = handler;
}

export const replayStorageKey = (householdId: string) => `mp-list-queue:${householdId}`;

/** Server errors that retrying cannot fix are dropped; a bad connection or an unknown fault is retried. */
export function classifyListError(error: unknown): FailureAction {
  if (!(error instanceof ListError)) return "retry";
  switch (error.code) {
    case "forbidden":
    case "invalid":
    case "not_found":
    case "conflict":
    case "no_plan":
      return "drop";
    default:
      return "retry";
  }
}

/** Sends one operation to the database. Throws a ListError. */
export async function executeListOp(client: MpClient, op: ListOp): Promise<void> {
  switch (op.kind) {
    case "check":
      // No row matched means a rebuild removed the item meanwhile: nothing left to check.
      await writeItemChecked(client, op);
      return;
    case "add":
      await insertManualItem(client, {
        id: op.itemId,
        listId: op.listId,
        householdId: op.householdId,
        item: op.item,
        position: op.position,
      });
      return;
    case "patch":
      await patchItem(client, op.itemId, op.patch);
      return;
    case "remove":
      await removeManualItem(client, op.itemId);
      return;
  }
}

/** Every cached items list of the household, so a confirmed write can be put in whichever holds it. */
function editItemCaches(
  queryClient: QueryClient,
  householdId: string,
  edit: (items: GroceryListItem[]) => GroceryListItem[],
): void {
  const caches = queryClient.getQueriesData<GroceryListItem[]>({
    queryKey: groceryListRootKey(householdId),
    predicate: (query) => query.queryKey[query.queryKey.length - 1] === "items",
  });
  for (const [key, items] of caches) {
    if (items) queryClient.setQueryData<GroceryListItem[]>(key, edit(items));
  }
}

/** Puts a sent operation's result in the cache, so dropping it from the queue changes nothing on screen. */
export function applySentOp(queryClient: QueryClient, householdId: string, op: ListOp): void {
  switch (op.kind) {
    case "check":
      editItemCaches(queryClient, householdId, (items) => withItemChecked(items, op));
      return;
    case "patch":
      editItemCaches(queryClient, householdId, (items) =>
        withItemPatched(items, op.itemId, op.patch),
      );
      return;
    case "remove":
      editItemCaches(queryClient, householdId, (items) => withoutItem(items, op.itemId));
      return;
    case "add": {
      const row = manualItemRow({
        id: op.itemId,
        listId: op.listId,
        householdId: op.householdId,
        item: op.item,
        position: op.position,
      });
      const key = ["grocery-list", householdId, op.listId, "items"] as const;
      if (queryClient.getQueryData(key)) {
        queryClient.setQueryData<GroceryListItem[]>(key, (items) => withItemAdded(items, row));
      }
      return;
    }
  }
}

export interface ListQueueDeps {
  client: MpClient;
  queryClient: QueryClient;
  householdId: string;
  /** Replaces the sender, for tests. */
  execute?: ReplayQueueOptions["execute"];
}

/** Creates a household's queue. Prefer `acquireListQueue`, which shares one per household. */
export function createListQueue(deps: ListQueueDeps): ReplayQueue {
  const { client, queryClient, householdId } = deps;
  return new ReplayQueue({
    storage,
    storageKey: replayStorageKey(householdId),
    execute: deps.execute ?? ((op) => executeListOp(client, op)),
    classify: classifyListError,
    onSent: (op) => applySentOp(queryClient, householdId, op),
    onDrop: (op, error) => {
      onWriteFailed?.(op, error);
      // The server refused it: put the screen back to what the server holds.
      void invalidateGroceryList(queryClient, householdId);
    },
    // Everything is sent: bring the cache in line with the database once.
    onIdle: () => void invalidateGroceryList(queryClient, householdId),
  });
}

const queues = new WeakMap<MpClient, Map<string, ReplayQueue>>();

/** The household's queue for this client, made on first use and picked up again from the device. */
export function acquireListQueue(
  client: MpClient,
  queryClient: QueryClient,
  householdId: string,
): ReplayQueue {
  let byHousehold = queues.get(client);
  if (!byHousehold) {
    byHousehold = new Map();
    queues.set(client, byHousehold);
  }
  let queue = byHousehold.get(householdId);
  if (!queue) {
    queue = createListQueue({ client, queryClient, householdId });
    byHousehold.set(householdId, queue);
    // Operations saved by an earlier session go out as soon as the queue exists.
    queue.kick();
  }
  return queue;
}

/** Forgets every queue of a client, for tests and sign-out. The saved operations stay on the device. */
export function releaseListQueues(client: MpClient): void {
  const byHousehold = queues.get(client);
  if (!byHousehold) return;
  for (const queue of byHousehold.values()) queue.stop();
  queues.delete(client);
}
