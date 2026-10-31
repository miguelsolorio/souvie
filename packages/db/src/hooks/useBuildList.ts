import { type GroceryList, type ListBuildResponse, weekStartFor } from "@mp/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSupabase } from "../context";
import { callListBuild, invalidateGroceryList, ListError, patchList } from "../lists";
import { useHousehold } from "./useHousehold";

/**
 * Builds the week's grocery list from the plan, or rebuilds it after the plan changed: calls the
 * `list-build` Edge Function and refreshes every list query when it answers. Check-offs, manual
 * items, and edits survive a rebuild (the function folds the new list into the old rows).
 *
 *   const build = useBuildList();
 *   build.mutate({ weekStart: "2026-11-02" });
 *
 * A week with nothing planned fails with ListError('no_plan'); `listErrorMessage(error)` words it.
 */
export function useBuildList() {
  const client = useSupabase();
  const queryClient = useQueryClient();
  const household = useHousehold();
  const householdId = household.data?.id;

  return useMutation<ListBuildResponse, Error, { weekStart: string }>({
    // One build at a time per device, so a double tap is not two builds.
    scope: { id: "list-build" },
    mutationFn: async ({ weekStart }) => {
      if (!householdId) throw new ListError("forbidden", "no household");
      return callListBuild(client, { weekStart: weekStartFor(weekStart), householdId });
    },
    onSuccess: () => invalidateGroceryList(queryClient, householdId),
  });
}

/**
 * Changes the list itself: rename it, mark it shopped (or reopen it), or set the household's aisle
 * order for it. Clients cannot touch anything else on a list (the build counter and fingerprint
 * belong to `list-build`).
 */
export function useUpdateList(listId: string | null | undefined) {
  const client = useSupabase();
  const queryClient = useQueryClient();
  const household = useHousehold();
  const householdId = household.data?.id;

  return useMutation<
    void,
    Error,
    { name?: string; status?: GroceryList["status"]; section_order?: string[] | null }
  >({
    mutationFn: async (patch) => {
      if (!listId) throw new ListError("not_found", "no list");
      await patchList(client, listId, patch);
    },
    onSuccess: () => invalidateGroceryList(queryClient, householdId),
  });
}
