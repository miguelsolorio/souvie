// Live progress for shopping runs (WS09): Supabase Realtime on shopping_runs, filtered to the
// household. Realtime applies Row Level Security to inserts and updates, so a member receives only
// their household's runs (the channel is shopping_runs:household_id=eq.<id>, under the anon key).
//
// A change is expected to carry the whole run row (docs/02: assumed, to be verified on the hosted
// project). It is laid over the cached run key by key (overlayRun), so a payload that leaves out a
// column keeps the cached value. When the status moved, the run's lines are refetched:
// shopping_run_items is not in the publication, and the lines change only when the status does.
import { useHousehold, useSupabase } from "@mp/db";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { overlayRun, type ShoppingRun, toRun } from "./logic";
import { shoppingRunItemsKey, shoppingRunKey, shoppingRunsKey } from "./useShoppingRun";

export const runChannelName = (householdId: string) =>
  `shopping_runs:household_id=eq.${householdId}`;

interface RunChange {
  eventType?: string;
  new?: Record<string, unknown>;
}

/** Subscribes while mounted. Mount it on the run list and the run detail. */
export function useRunRealtime() {
  const client = useSupabase();
  const queryClient = useQueryClient();
  const household = useHousehold();
  const householdId = household.data?.id;

  useEffect(() => {
    if (!householdId) return;
    const channel = client
      .channel(runChannelName(householdId))
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "shopping_runs",
          filter: `household_id=eq.${householdId}`,
        },
        (payload: RunChange) => {
          const row = payload.new;
          const runId = typeof row?.id === "string" ? row.id : undefined;
          if (!row || !runId) {
            void queryClient.invalidateQueries({ queryKey: shoppingRunsKey(householdId) });
            return;
          }
          const next = toRun(row);
          const key = shoppingRunKey(householdId, runId);
          const held = queryClient.getQueryData<ShoppingRun | null>(key);
          queryClient.setQueryData<ShoppingRun | null>(key, held ? overlayRun(held, row) : next);
          if (!held || held.status !== next.status) {
            void queryClient.invalidateQueries({
              queryKey: shoppingRunItemsKey(householdId, runId),
            });
          }
          queryClient.setQueryData<ShoppingRun[] | undefined>(
            shoppingRunsKey(householdId),
            (runs) => {
              if (!runs) return runs;
              const found = runs.some((r) => r.id === runId);
              return found
                ? runs.map((r) => (r.id === runId ? { ...overlayRun(r, row), transcript: [] } : r))
                : [{ ...next, transcript: [] }, ...runs];
            },
          );
        },
      )
      .subscribe();
    return () => {
      void client.removeChannel(channel);
    };
  }, [client, queryClient, householdId]);
}
