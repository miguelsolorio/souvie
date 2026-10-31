import type { GroceryListItem, ItemPatch } from "@mp/core";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useSupabase } from "../context";
import { newId } from "../ids";
import { acquireListQueue } from "../offline/listQueue";
import { useHousehold } from "./useHousehold";
import { useSession } from "./useSession";

/**
 * The household's replay queue plus who is acting, for the hooks that change items. Returns null
 * until the household and the session have loaded, and the hooks below then do nothing.
 */
function useActor() {
  const client = useSupabase();
  const queryClient = useQueryClient();
  const household = useHousehold();
  const { user } = useSession();
  const householdId = household.data?.id;
  const userId = user?.id;
  if (!householdId || !userId) return null;
  return { queue: acquireListQueue(client, queryClient, householdId), householdId, userId };
}

/**
 * Checks an item off or puts it back. The screen answers on the tap: the change goes into the
 * device's replay queue and is laid over the list at once (see useGroceryListItems), whatever the
 * connection is doing, and is sent in the order it was made as soon as it can be. Ten check-offs in
 * airplane mode are ten queued writes that go out, once each, on reconnect, with the checker set
 * to the signed-in member and the time of each tap kept so the newest toggle wins.
 *
 *   const toggle = useToggleItem();
 *   toggle(item);          // flips it
 *   toggle(item, true);    // checks it
 */
export function useToggleItem() {
  const actor = useActor();
  return useCallback(
    (item: Pick<GroceryListItem, "id" | "checked">, checked: boolean = !item.checked) => {
      if (!actor) return;
      actor.queue.enqueue({
        kind: "check",
        id: newId(),
        itemId: item.id,
        checked,
        userId: actor.userId,
        at: new Date().toISOString(),
      });
    },
    [actor],
  );
}

/**
 * Changes an item's quantity, unit, or section, or renames it. An edit of the amount or section
 * marks the item as edited, so a rebuild keeps the person's answer. Queued like a check-off.
 */
export function useEditItem() {
  const actor = useActor();
  return useCallback(
    (itemId: string, patch: ItemPatch) => {
      if (!actor) return;
      actor.queue.enqueue({ kind: "patch", id: newId(), itemId, patch });
    },
    [actor],
  );
}

/**
 * Takes an item off the list. A manual item is deleted. An automatic one is marked removed
 * (`excluded_reason = 'manual'`) instead of deleted, because a rebuild would bring a deleted one
 * straight back; the removal stays across rebuilds and shows under "Removed" where it can be put
 * back with `restore`.
 */
export function useRemoveItem() {
  const actor = useActor();
  const remove = useCallback(
    (item: Pick<GroceryListItem, "id" | "is_manual">) => {
      if (!actor) return;
      if (item.is_manual) actor.queue.enqueue({ kind: "remove", id: newId(), itemId: item.id });
      else {
        actor.queue.enqueue({
          kind: "patch",
          id: newId(),
          itemId: item.id,
          patch: { excluded_reason: "manual" },
        });
      }
    },
    [actor],
  );
  const restore = useCallback(
    (itemId: string) => {
      if (!actor) return;
      actor.queue.enqueue({
        kind: "patch",
        id: newId(),
        itemId,
        patch: { excluded_reason: null },
      });
    },
    [actor],
  );
  return { remove, restore };
}
