import { weekStartFor } from "@mp/core";
import {
  type MutationOptions,
  type QueryClient,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type { MpClient } from "../client";
import { useSupabase } from "../context";
import {
  findCachedEntry,
  invalidateMealPlan,
  mealPlanEntriesKey,
  type PlanEntry,
  planRetryDelay,
  removeEntry,
  shouldRetryPlanWrite,
  withEntry,
  withoutEntry,
} from "../planning";

export interface DeleteEntryInput {
  id: string;
  householdId: string;
  planId: string;
}

interface DeleteContext {
  removed: PlanEntry | undefined;
}

/**
 * The mutation behind useDeleteEntry, as plain options so tests can run it without React.
 * The entry leaves the screen at once; if the delete fails it comes back where it was.
 * Deleting an entry that is already gone counts as done, so a retry never fails on its own
 * earlier success.
 */
export function deleteEntryOptions(
  client: MpClient,
  queryClient: QueryClient,
): MutationOptions<void, Error, DeleteEntryInput, DeleteContext> {
  return {
    retry: shouldRetryPlanWrite,
    retryDelay: planRetryDelay,

    mutationFn: (input) => removeEntry(client, input.id),

    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: ["meal-plan", input.householdId] });
      const removed = findCachedEntry(queryClient, input.householdId, input.id);
      queryClient.setQueryData<PlanEntry[]>(
        mealPlanEntriesKey(input.householdId, input.planId),
        (old) => withoutEntry(old, input.id),
      );
      return { removed };
    },

    onError: (_error, input, context) => {
      const removed = context?.removed;
      if (!removed) return;
      queryClient.setQueryData<PlanEntry[]>(
        mealPlanEntriesKey(input.householdId, input.planId),
        (old) => withEntry(old, removed),
      );
    },

    onSettled: async (_data, _error, input, context) => {
      await invalidateMealPlan(queryClient, {
        householdId: input.householdId,
        weekStart: context?.removed ? weekStartFor(context.removed.date) : null,
        planId: input.planId,
      });
    },
  };
}

/** Removes an entry from the plan, optimistically. See deleteEntryOptions. */
export function useDeleteEntry() {
  const client = useSupabase();
  const queryClient = useQueryClient();
  return useMutation(deleteEntryOptions(client, queryClient));
}
