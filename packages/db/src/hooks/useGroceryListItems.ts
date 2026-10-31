import type { GroceryListItem } from "@mp/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useSyncExternalStore } from "react";
import { useSupabase } from "../context";
import { fetchListItems, groceryItemsKey } from "../lists";
import {
  acquireListQueue,
  queueRegistryVersion,
  subscribeQueueRegistry,
} from "../offline/listQueue";
import { type ListOp, overlayOps } from "../offline/replayQueue";
import { useHousehold } from "./useHousehold";
import { useSession } from "./useSession";

const NO_OPS: readonly ListOp[] = [];
const noSubscription = () => () => {};

/**
 * The operations this device has made on the household's lists and not yet sent, oldest first,
 * as a live value. Empty when everything is saved on the server. Screens use its length for
 * "N changes waiting to sync".
 */
export function usePendingListOps(householdId: string | null | undefined): readonly ListOp[] {
  const client = useSupabase();
  const queryClient = useQueryClient();
  const { user } = useSession();
  const userId = user?.id;
  // The queue is the signed-in person's. One that was released (sign-out, a change of user) is
  // stopped for good, so the registry's version is a dependency: after a release, ask again.
  const version = useSyncExternalStore(subscribeQueueRegistry, queueRegistryVersion, () => 0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the reason to ask again.
  const queue = useMemo(
    () =>
      householdId && userId ? acquireListQueue(client, queryClient, { householdId, userId }) : null,
    [client, queryClient, householdId, userId, version],
  );
  return useSyncExternalStore(
    queue ? queue.subscribe : noSubscription,
    () => queue?.ops() ?? NO_OPS,
    () => NO_OPS,
  );
}

/**
 * A list's items in list order, as this device should show them: the server's items with the
 * operations still waiting in the replay queue laid over them. A check-off therefore shows at
 * once, in airplane mode, and after a restart, and a refetch or a remote change cannot undo it.
 *
 * Persisted like the list, with the household in the key. `pendingCount` is the number of
 * operations not yet saved on the server.
 */
export function useGroceryListItems(listId: string | null | undefined) {
  const client = useSupabase();
  const household = useHousehold();
  const householdId = household.data?.id;
  const pending = usePendingListOps(householdId);

  const query = useQuery({
    queryKey: groceryItemsKey(householdId, listId),
    enabled: Boolean(householdId && listId),
    meta: { persist: true },
    queryFn: (): Promise<GroceryListItem[]> => {
      if (!listId) return Promise.resolve([]);
      return fetchListItems(client, listId);
    },
  });

  const server = query.data;
  const data = useMemo(
    () => (server ? overlayOps(server, pending, listId) : undefined),
    [server, pending, listId],
  );

  return {
    data,
    pendingCount: pending.length,
    isPending: query.isPending,
    isError: query.isError,
    isRefetching: query.isRefetching,
    fetchStatus: query.fetchStatus,
    refetch: query.refetch,
  };
}
