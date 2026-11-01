// Data for the shopping run screens (WS09): the household's runs, one run and its items, and the
// three actions a person takes on a run (start, approve, cancel).
//
// Run items hold Kroger product data (names, sizes, prices as returned). Kroger's terms end cart
// display data with the session, so none of these queries is persisted to the device: no
// `meta: { persist: true }`, and the item queries are dropped as soon as no screen shows them.
import { RetailerId } from "@mp/core";
import { useHousehold, useSupabase } from "@mp/db";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { track } from "../../observability/track";
import {
  type ReviewDraft,
  type RunItem,
  type ShoppingRun,
  toDecisions,
  toItem,
  toRun,
} from "./logic";

const RUN_COLUMNS =
  "id, household_id, list_id, retailer, store_name, trigger, status, cart_snapshot, subtotal_usd, transcript, error, progress, approved_at, policy, started_at, finished_at, created_at";
const LIST_COLUMNS =
  "id, household_id, list_id, retailer, store_name, trigger, status, cart_snapshot, subtotal_usd, error, progress, approved_at, policy, started_at, finished_at, created_at";
const ITEM_COLUMNS =
  "id, run_id, position, display_name, section, product_id, upc, product_name, size, qty, unit_price_usd, line_total_usd, status, alternatives, user_decision, flags, reason, cart_qty, delta_result";

export const shoppingRunsKey = (householdId: string | undefined) =>
  ["shopping-runs", householdId] as const;
export const shoppingRunKey = (householdId: string | undefined, runId: string | undefined) =>
  ["shopping-runs", householdId, runId] as const;
export const shoppingRunItemsKey = (householdId: string | undefined, runId: string | undefined) =>
  ["shopping-runs", householdId, runId, "items"] as const;

/** Errors the run actions report, in words for the person. */
export class RunActionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RunActionError";
    this.code = code;
  }
}

const ENQUEUE_MESSAGES: Record<string, string> = {
  run_in_progress: "This list is already being shopped. Open the run to see where it is.",
  connection_inactive: "Your store account needs a new sign-in first.",
  connection_not_found: "Connect a store first.",
  list_not_found: "This list is not in your household.",
  daily_run_limit: "That is the most runs for one day. Try again tomorrow.",
  invalid_policy: "The shopping rules for this run are not valid.",
  policy_owner_only: "Only the household owner can change the shopping rules.",
};

function enqueueError(message: string): RunActionError {
  const code =
    Object.keys(ENQUEUE_MESSAGES).find((key) => message.includes(key)) ?? "internal_error";
  return new RunActionError(code, ENQUEUE_MESSAGES[code] ?? "Could not start shopping. Try again.");
}

/** The household's runs, newest first. */
export function useShoppingRuns() {
  const client = useSupabase();
  const household = useHousehold();
  const householdId = household.data?.id;
  return useQuery({
    queryKey: shoppingRunsKey(householdId),
    enabled: Boolean(householdId),
    queryFn: async (): Promise<ShoppingRun[]> => {
      if (!householdId) return [];
      const { data, error } = await client
        .from("shopping_runs")
        .select(LIST_COLUMNS)
        .eq("household_id", householdId)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw new Error(error.message);
      return (data ?? []).map((row) => toRun({ ...row, transcript: [] }));
    },
  });
}

/** One run, with its transcript. */
export function useShoppingRun(runId: string | undefined) {
  const client = useSupabase();
  const household = useHousehold();
  const householdId = household.data?.id;
  return useQuery({
    queryKey: shoppingRunKey(householdId, runId),
    enabled: Boolean(householdId && runId),
    queryFn: async (): Promise<ShoppingRun | null> => {
      if (!householdId || !runId) return null;
      const { data, error } = await client
        .from("shopping_runs")
        .select(RUN_COLUMNS)
        .eq("household_id", householdId)
        .eq("id", runId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data ? toRun(data) : null;
    },
  });
}

/** A run's lines. Kept in memory only, and dropped when the screen closes. */
export function useRunItems(runId: string | undefined) {
  const client = useSupabase();
  const household = useHousehold();
  const householdId = household.data?.id;
  return useQuery({
    queryKey: shoppingRunItemsKey(householdId, runId),
    enabled: Boolean(householdId && runId),
    gcTime: 0,
    queryFn: async (): Promise<RunItem[]> => {
      if (!householdId || !runId) return [];
      const { data, error } = await client
        .from("shopping_run_items")
        .select(ITEM_COLUMNS)
        .eq("household_id", householdId)
        .eq("run_id", runId)
        .order("position", { ascending: true });
      if (error) throw new Error(error.message);
      return (data ?? []).map((row) => toItem(row));
    },
  });
}

/** "Shop this list": enqueue_shopping_run with no policy, so the run gets the default one. */
export function useStartRun() {
  const client = useSupabase();
  const queryClient = useQueryClient();
  const household = useHousehold();
  const householdId = household.data?.id;
  return useMutation({
    mutationFn: async (args: { listId: string; connectionId: string }): Promise<string> => {
      const { data, error } = await client.rpc("enqueue_shopping_run", {
        list_id: args.listId,
        connection_id: args.connectionId,
        trigger: "manual",
        policy: null,
      });
      if (error) throw enqueueError(error.message);
      if (typeof data !== "string")
        throw new RunActionError("internal_error", "Could not start shopping. Try again.");
      return data;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: shoppingRunsKey(householdId) }),
  });
}

/** "Approve and fill cart": the run-approve function with the person's edits. */
export function useApproveRun(runId: string | undefined) {
  const client = useSupabase();
  const queryClient = useQueryClient();
  const household = useHousehold();
  const householdId = household.data?.id;
  return useMutation({
    mutationFn: async (args: { items: readonly RunItem[]; draft: ReviewDraft }) => {
      if (!runId) throw new RunActionError("no_run", "This run is gone.");
      const { data, error } = await client.functions.invoke("run-approve", {
        body: { runId, decisions: toDecisions(args.items, args.draft) },
      });
      let payload: unknown = data;
      if (error) {
        if (!(error instanceof FunctionsHttpError)) {
          throw new RunActionError(
            "network",
            "We could not reach the server. Check your connection.",
          );
        }
        payload = await error.context.json().catch(() => null);
      }
      const result = payload as { ok?: boolean; error?: string; message?: string } | null;
      if (!result?.ok) {
        throw new RunActionError(
          result?.error ?? "internal_error",
          result?.message ?? "Could not approve. Try again.",
        );
      }
      return result;
    },
    onSuccess: (_result, args) => {
      // review_edits: how many lines the person changed before approving. No product or price.
      const run = queryClient.getQueryData<ShoppingRun | null>(shoppingRunKey(householdId, runId));
      const retailer = RetailerId.safeParse(run?.retailer);
      if (retailer.success) {
        track.runApproved({
          retailer: retailer.data,
          review_edits: Object.keys(args.draft).length,
        });
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: shoppingRunsKey(householdId) }),
  });
}

/** Cancel a run that has not finished. */
export function useCancelRun(runId: string | undefined) {
  const client = useSupabase();
  const queryClient = useQueryClient();
  const household = useHousehold();
  const householdId = household.data?.id;
  return useMutation({
    mutationFn: async () => {
      if (!runId) return;
      const { error } = await client.rpc("cancel_shopping_run", { run_id: runId });
      if (error) throw new RunActionError("cancel_failed", "This run can no longer be cancelled.");
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: shoppingRunsKey(householdId) }),
  });
}
