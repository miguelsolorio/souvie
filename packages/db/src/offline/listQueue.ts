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

/**
 * Where one person's queue for one household is saved. The user is in the key, so two people on one
 * phone never share a queue: what a person queued stays parked under their key, untouched, until
 * that person signs in again on this device, and only the signed-in person's queue is ever sent.
 */
export const replayStorageKey = (userId: string, householdId: string) =>
  `mp-list-queue:${userId}:${householdId}`;

/** Whose queue it is: the signed-in person, acting in one household. */
export interface ListQueueOwner {
  householdId: string;
  userId: string;
}

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

export interface ListQueueDeps extends ListQueueOwner {
  client: MpClient;
  queryClient: QueryClient;
  /** Replaces the sender, for tests. */
  execute?: ReplayQueueOptions["execute"];
}

/** Creates a person's queue for a household. Prefer `acquireListQueue`, which shares one. */
export function createListQueue(deps: ListQueueDeps): ReplayQueue {
  const { client, queryClient, householdId, userId } = deps;
  return new ReplayQueue({
    storage,
    storageKey: replayStorageKey(userId, householdId),
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
const ownerKey = (owner: ListQueueOwner) => `${owner.userId}:${owner.householdId}`;

// A queue that was released is stopped for good, so anything that kept a reference to it holds a
// dead queue. `queueRegistryVersion` changes on every release, so a hook can tell and ask again.
let registryVersion = 0;
const registryListeners = new Set<() => void>();

export function queueRegistryVersion(): number {
  return registryVersion;
}

export function subscribeQueueRegistry(listener: () => void): () => void {
  registryListeners.add(listener);
  return () => {
    registryListeners.delete(listener);
  };
}

function registryChanged(): void {
  registryVersion += 1;
  for (const listener of registryListeners) listener();
}

/**
 * The signed-in person's queue for a household, made on first use and picked up again from the
 * device. A queue is never shared between people: ask with the user who is signed in now.
 */
export function acquireListQueue(
  client: MpClient,
  queryClient: QueryClient,
  owner: ListQueueOwner,
): ReplayQueue {
  let byOwner = queues.get(client);
  if (!byOwner) {
    byOwner = new Map();
    queues.set(client, byOwner);
  }
  let queue = byOwner.get(ownerKey(owner));
  if (!queue) {
    queue = createListQueue({ client, queryClient, ...owner });
    byOwner.set(ownerKey(owner), queue);
    // Operations this person saved in an earlier session go out as soon as the queue exists.
    queue.kick();
  }
  return queue;
}

/**
 * Stops one person's queue and forgets it, for sign-out and a change of user or household. The
 * loop and its retry timer stop; the operations stay saved on the device under that person's key,
 * untouched, for the next time they sign in.
 */
export function releaseListQueue(client: MpClient, owner: ListQueueOwner): void {
  const byOwner = queues.get(client);
  const queue = byOwner?.get(ownerKey(owner));
  if (!byOwner || !queue) return;
  queue.stop();
  byOwner.delete(ownerKey(owner));
  registryChanged();
}

/** Stops and forgets every queue of a client. The saved operations stay on the device. */
export function releaseListQueues(client: MpClient): void {
  const byOwner = queues.get(client);
  if (!byOwner) return;
  for (const queue of byOwner.values()) queue.stop();
  queues.delete(client);
  registryChanged();
}

/**
 * Starts sending the signed-in person's saved and new operations for a household, and returns the
 * function that ends it. Call the returned function on sign-out and when the user or household
 * changes: it stops that queue's loop and timer and leaves what is saved parked under the key.
 * Nobody else's queue is touched, so a second person signing in on the same phone sends none of
 * the first person's operations, and the first person's replay when they sign back in.
 */
export function startListSync(
  client: MpClient,
  queryClient: QueryClient,
  owner: ListQueueOwner,
): () => void {
  acquireListQueue(client, queryClient, owner).kick();
  return () => releaseListQueue(client, owner);
}
