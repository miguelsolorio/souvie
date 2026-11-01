import type { ConfirmOrderInput, OrderPatch } from "@mp/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSupabase } from "../context";
import { historyRootKey } from "../history";
import {
  confirmOrder,
  fetchOrder,
  fetchOrderForRun,
  fetchOrderLines,
  fetchRunForOrder,
  listOrders,
  type OrderError,
  type OrderLine,
  type OrderRange,
  type OrderWithStore,
  orderKey,
  orderLinesKey,
  ordersKey,
  ordersRootKey,
  type RunForOrder,
  runForOrderKey,
  runOrderKey,
  updateOrder,
} from "../orders";
import { useHousehold } from "./useHousehold";

// None of these queries is persisted to the device: an order holds the household's spend, and its
// lines hold retailer product names and amounts (docs/04-integrations.md §Kroger).

/** The household's orders confirmed in `range`, newest first. */
export function useOrders(range: OrderRange = {}) {
  const client = useSupabase();
  const household = useHousehold();
  const householdId = household.data?.id;
  return useQuery({
    queryKey: ordersKey(householdId, range),
    enabled: Boolean(householdId),
    queryFn: (): Promise<OrderWithStore[]> => {
      if (!householdId) return Promise.resolve([]);
      return listOrders(client, householdId, range);
    },
  });
}

/** One order, or null when it is not in the household. */
export function useOrder(orderId: string | undefined) {
  const client = useSupabase();
  const household = useHousehold();
  const householdId = household.data?.id;
  return useQuery({
    queryKey: orderKey(householdId, orderId),
    enabled: Boolean(householdId && orderId),
    queryFn: (): Promise<OrderWithStore | null> => {
      if (!householdId || !orderId) return Promise.resolve(null);
      return fetchOrder(client, householdId, orderId);
    },
  });
}

/** The order recorded for a run: null until someone confirms one. */
export function useRunOrder(runId: string | undefined) {
  const client = useSupabase();
  const household = useHousehold();
  const householdId = household.data?.id;
  return useQuery({
    queryKey: runOrderKey(householdId, runId),
    enabled: Boolean(householdId && runId),
    queryFn: (): Promise<OrderWithStore | null> => {
      if (!householdId || !runId) return Promise.resolve(null);
      return fetchOrderForRun(client, householdId, runId);
    },
  });
}

/** A run's status, store and subtotal, and its connection's modality, for the order prompt. */
export function useRunForOrder(runId: string | undefined) {
  const client = useSupabase();
  const household = useHousehold();
  const householdId = household.data?.id;
  return useQuery({
    queryKey: runForOrderKey(householdId, runId),
    enabled: Boolean(householdId && runId),
    queryFn: (): Promise<RunForOrder | null> => {
      if (!householdId || !runId) return Promise.resolve(null);
      return fetchRunForOrder(client, householdId, runId);
    },
  });
}

/** What the store's cart held for an order's run. Dropped as soon as no screen shows it. */
export function useOrderLines(runId: string | undefined) {
  const client = useSupabase();
  const household = useHousehold();
  const householdId = household.data?.id;
  return useQuery({
    queryKey: orderLinesKey(householdId, runId),
    enabled: Boolean(householdId && runId),
    gcTime: 0,
    queryFn: (): Promise<OrderLine[]> => {
      if (!householdId || !runId) return Promise.resolve([]);
      return fetchOrderLines(client, householdId, runId);
    },
  });
}

/**
 * "I placed it" for a run. Returns the new order's id. A failure is an OrderError;
 * `orderErrorMessage(error)` words it. When the run already has an order (`already_confirmed`),
 * the caches are refreshed so the screen shows that order.
 */
export function useConfirmOrder(runId: string | undefined) {
  const client = useSupabase();
  const queryClient = useQueryClient();
  const household = useHousehold();
  const householdId = household.data?.id;

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ordersRootKey(householdId) }),
      queryClient.invalidateQueries({ queryKey: historyRootKey(householdId) }),
    ]);

  return useMutation<string, OrderError, ConfirmOrderInput>({
    // One confirmation at a time per device, so a double tap is not two requests.
    scope: { id: `confirm-order:${runId ?? ""}` },
    mutationFn: async (input) => {
      if (!runId) throw new Error("no run");
      return confirmOrder(client, runId, input);
    },
    onSuccess: refresh,
    onError: (error) => {
      if (error.code === "already_confirmed") void refresh();
    },
  });
}

/** Corrects an order: its total, window, order number, notes, or status (cancel, picked up). */
export function useUpdateOrder(orderId: string | undefined) {
  const client = useSupabase();
  const queryClient = useQueryClient();
  const household = useHousehold();
  const householdId = household.data?.id;

  return useMutation<OrderWithStore, OrderError, OrderPatch>({
    mutationFn: async (patch) => {
      if (!orderId) throw new Error("no order");
      return updateOrder(client, orderId, patch);
    },
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ordersRootKey(householdId) }),
        queryClient.invalidateQueries({ queryKey: historyRootKey(householdId) }),
      ]),
  });
}
