import { type GroceryListItem, ManualItemInput } from "@mp/core";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useSupabase } from "../context";
import { newId } from "../ids";
import { groceryItemsKey, nextItemPosition } from "../lists";
import { acquireListQueue } from "../offline/listQueue";
import { useHousehold } from "./useHousehold";
import { useSession } from "./useSession";

/**
 * Adds a free-text item to a list ("paper towels", "birthday candles"). The item gets its id on
 * the device, appears at once, and is sent when it can be; a retry sends the same id and the
 * database ignores the second one (INSERT ... ON CONFLICT DO NOTHING), so a flaky connection never
 * makes a duplicate. A rebuild never touches a manual item.
 *
 *   const add = useAddManualItem(listId);
 *   add({ display_name: "Paper towels", qty: 2, section: "household" });
 */
export function useAddManualItem(listId: string | null | undefined) {
  const client = useSupabase();
  const queryClient = useQueryClient();
  const household = useHousehold();
  const householdId = household.data?.id;
  const { user } = useSession();
  const userId = user?.id;

  return useCallback(
    (input: ManualItemInput): string | null => {
      if (!householdId || !userId || !listId) return null;
      const item = ManualItemInput.parse(input);
      const held = queryClient.getQueryData<GroceryListItem[]>(
        groceryItemsKey(householdId, listId),
      );
      const itemId = newId();
      acquireListQueue(client, queryClient, { householdId, userId }).enqueue({
        kind: "add",
        id: newId(),
        itemId,
        listId,
        householdId,
        item,
        position: nextItemPosition(held ?? []),
      });
      return itemId;
    },
    [client, queryClient, householdId, userId, listId],
  );
}
