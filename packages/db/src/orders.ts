// Typed calls, query keys, and errors for orders (WS12). The hooks in ./hooks/useOrders.ts are thin
// wrappers over this file, so the interesting logic is testable without rendering React.
//
// An order is the household's own record that it placed an order: no retailer exposes order
// history through an API, so a row is the run ledger plus a person's confirmation (R19: a run
// reaching cart_ready is not an order). A member records one with the confirm_order function,
// which checks the run, takes the household and retailer from it and stamps the caller. After
// that a member can correct the total, the window, the order number, the notes and the status;
// nothing else about an order is client-writable (supabase/migrations/*_ws12_orders_history.sql).
//
// Retailer terms (docs/04-integrations.md §Kroger, R21): an order keeps one amount, the total a
// person entered. Its lines are read from the run's own ledger, which keeps the approved product,
// quantity and amount as the household's purchase record. None of this is persisted to the device.
import {
  ConfirmOrderInput,
  type Modality,
  Order,
  OrderPatch,
  type OrderStatus,
  type RetailerId,
} from "@mp/core";
import type { MpClient } from "./client";

// ---------------------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------------------
// The household is in every key, so one household's orders can never appear under another's.
// ['orders', householdId] is the prefix to invalidate after any order write.

export const ordersRootKey = (householdId: string | null | undefined) =>
  ["orders", householdId] as const;

export interface OrderRange {
  /** Orders confirmed at or after this instant (ISO timestamp). */
  from?: string;
  /** Orders confirmed before this instant. */
  to?: string;
  /** At most this many, newest first. Defaults to 200. */
  limit?: number;
}

export const ordersKey = (householdId: string | null | undefined, range: OrderRange = {}) =>
  [
    "orders",
    householdId,
    "list",
    range.from ?? null,
    range.to ?? null,
    range.limit ?? null,
  ] as const;

export const orderKey = (
  householdId: string | null | undefined,
  orderId: string | null | undefined,
) => ["orders", householdId, "order", orderId] as const;

export const runOrderKey = (
  householdId: string | null | undefined,
  runId: string | null | undefined,
) => ["orders", householdId, "run", runId] as const;

export const orderLinesKey = (
  householdId: string | null | undefined,
  runId: string | null | undefined,
) => ["orders", householdId, "lines", runId] as const;

export const runForOrderKey = (
  householdId: string | null | undefined,
  runId: string | null | undefined,
) => ["orders", householdId, "run-for-order", runId] as const;

// ---------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------

export type OrderErrorCode =
  | "network"
  | "not_authenticated"
  | "run_not_found"
  | "run_not_confirmable"
  | "already_confirmed"
  | "invalid_total"
  | "invalid_window"
  | "invalid"
  | "forbidden"
  | "not_found"
  | "unknown";

export class OrderError extends Error {
  readonly code: OrderErrorCode;

  constructor(code: OrderErrorCode, message?: string) {
    super(message ?? code);
    this.name = "OrderError";
    this.code = code;
  }
}

/** Each code in words for the person. */
export const ORDER_ERROR_MESSAGES: Record<OrderErrorCode, string> = {
  network: "We could not reach the server. Check your connection and try again.",
  not_authenticated: "Sign in again to confirm this order.",
  run_not_found: "This run is not in your household.",
  run_not_confirmable:
    "This cart is not ready to confirm. Approve it and let the store fill the cart first.",
  already_confirmed: "This order is already confirmed.",
  invalid_total: "Enter the total you paid, from $0 to $100,000.",
  invalid_window:
    "The window needs a start. Its end must come after the start and within a day of it.",
  invalid: "That change is not valid. Check the amounts and times.",
  forbidden: "You can't change that order.",
  not_found: "That order is gone. Pull to refresh.",
  unknown: "Something went wrong. Try again.",
};

export function orderErrorMessage(error: unknown): string {
  if (error instanceof OrderError) return ORDER_ERROR_MESSAGES[error.code];
  return ORDER_ERROR_MESSAGES.unknown;
}

const NETWORK_MESSAGE = /network|fetch|timeout|timed out|offline|abort|connection|econn|enotfound/i;
const FUNCTION_CODES = [
  "not_authenticated",
  "run_not_found",
  "run_not_confirmable",
  "already_confirmed",
  "invalid_total",
  "invalid_window",
] as const satisfies readonly OrderErrorCode[];

/**
 * Maps a PostgREST failure to an OrderError. `status` is the HTTP status of the response: 0 means
 * the request never got one (offline, DNS, a dropped socket). confirm_order raises plain codes in
 * the message (SQLSTATE P0001); the table's own checks and the unique key come back as SQLSTATEs.
 */
export function toOrderError(
  failure: { message?: string | null; code?: string | null },
  status?: number,
): OrderError {
  const message = (failure.message ?? "").trim();
  const code = failure.code ?? "";
  if (status === 0 || (status === undefined && !code && NETWORK_MESSAGE.test(message))) {
    return new OrderError("network", message || "network error");
  }
  const named = FUNCTION_CODES.find((name) => message === name);
  if (named) return new OrderError(named, message);
  if (code === "42501") return new OrderError("forbidden", message);
  if (code === "23505") return new OrderError("already_confirmed", message);
  if (code === "23514" || code === "22P02" || code === "22003" || code === "23502") {
    return new OrderError("invalid", message);
  }
  if (status !== undefined && status >= 500) return new OrderError("network", message);
  return new OrderError("unknown", message || "unknown error");
}

// ---------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------

// Every column but `raw`: the Tier 3 confirmation details are not for the screen.
const ORDER_COLUMNS =
  "id, household_id, run_id, retailer, retailer_order_id, modality, slot_start, slot_end, total_usd, status, confirmed_by, confirmed_at, notes, created_at, updated_at";
// The store is the run's: an order has no store column of its own, so the read embeds it.
const ORDER_SELECT = `${ORDER_COLUMNS}, shopping_runs(store_name)`;

const DEFAULT_LIMIT = 200;

/** An order and the name of the store its run shopped, as the run recorded it. */
export type OrderWithStore = Order & { store_name: string | null };

function parseOrder(row: unknown): OrderWithStore {
  const parsed = Order.safeParse(row);
  if (!parsed.success) throw new OrderError("unknown", "an orders row did not match its schema");
  const run = (row as { shopping_runs?: { store_name?: string | null } | null }).shopping_runs;
  return { ...parsed.data, store_name: run?.store_name ?? null };
}

/** The household's orders confirmed in `range`, newest first. */
export async function listOrders(
  client: MpClient,
  householdId: string,
  range: OrderRange = {},
): Promise<OrderWithStore[]> {
  let query = client
    .from("orders")
    .select(ORDER_SELECT)
    .eq("household_id", householdId)
    .order("confirmed_at", { ascending: false });
  if (range.from) query = query.gte("confirmed_at", range.from);
  if (range.to) query = query.lt("confirmed_at", range.to);
  const { data, error, status } = await query.limit(range.limit ?? DEFAULT_LIMIT);
  if (error) throw toOrderError(error, status);
  return ((data ?? []) as unknown[]).map(parseOrder);
}

/** One order, or null when it is not in the household. */
export async function fetchOrder(
  client: MpClient,
  householdId: string,
  orderId: string,
): Promise<OrderWithStore | null> {
  const { data, error, status } = await client
    .from("orders")
    .select(ORDER_SELECT)
    .eq("household_id", householdId)
    .eq("id", orderId)
    .maybeSingle();
  if (error) throw toOrderError(error, status);
  return data ? parseOrder(data as unknown) : null;
}

/** The order recorded for a run, or null while nobody has confirmed one. */
export async function fetchOrderForRun(
  client: MpClient,
  householdId: string,
  runId: string,
): Promise<OrderWithStore | null> {
  const { data, error, status } = await client
    .from("orders")
    .select(ORDER_SELECT)
    .eq("household_id", householdId)
    .eq("run_id", runId)
    .maybeSingle();
  if (error) throw toOrderError(error, status);
  return data ? parseOrder(data as unknown) : null;
}

/** What the "Did you place this order?" prompt needs to know about a run. */
export interface RunForOrder {
  id: string;
  status: string;
  retailer: RetailerId;
  store_name: string | null;
  /** What the run's cart held when it was filled; prefills the total. Null when none was set. */
  subtotal_usd: number | null;
  approved_at: string | null;
  finished_at: string | null;
  /** The run's connection modality, to prefill pickup or delivery. Null if the connection is gone. */
  modality: Modality | null;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** A run and the modality of its connection, or null when the run is not in the household. */
export async function fetchRunForOrder(
  client: MpClient,
  householdId: string,
  runId: string,
): Promise<RunForOrder | null> {
  const run = await client
    .from("shopping_runs")
    .select(
      "id, status, retailer, store_name, subtotal_usd, approved_at, finished_at, connection_id",
    )
    .eq("household_id", householdId)
    .eq("id", runId)
    .maybeSingle();
  if (run.error) throw toOrderError(run.error, run.status);
  const row = run.data;
  if (!row) return null;

  let modality: Modality | null = null;
  if (row.connection_id) {
    const connection = await client
      .from("retailer_connections")
      .select("modality")
      .eq("household_id", householdId)
      .eq("id", row.connection_id)
      .maybeSingle();
    if (connection.error) throw toOrderError(connection.error, connection.status);
    modality = connection.data?.modality ?? null;
  }
  return {
    id: row.id,
    status: row.status,
    retailer: row.retailer as RetailerId,
    store_name: row.store_name,
    subtotal_usd: toNumber(row.subtotal_usd),
    approved_at: row.approved_at,
    finished_at: row.finished_at,
    modality,
  };
}

/**
 * One line of an order: what the store's cart held for it. Name and size are the retailer's own
 * words, and the amounts are the run's, shown as the ledger holds them.
 */
export interface OrderLine {
  id: string;
  display_name: string;
  product_name: string | null;
  size: string | null;
  quantity: number;
  unit_price_usd: number | null;
  line_total_usd: number | null;
}

const LINE_COLUMNS =
  "id, position, display_name, product_name, size, cart_qty, unit_price_usd, line_total_usd";

/**
 * The lines of a run that went into the store's cart (cart_qty above zero), in list order. A run
 * that failed or was cancelled before approval loses its products 24 hours later (retention), so
 * an order whose lines are gone shows none.
 */
export async function fetchOrderLines(
  client: MpClient,
  householdId: string,
  runId: string,
): Promise<OrderLine[]> {
  const { data, error, status } = await client
    .from("shopping_run_items")
    .select(LINE_COLUMNS)
    .eq("household_id", householdId)
    .eq("run_id", runId)
    .gt("cart_qty", 0)
    .order("position", { ascending: true });
  if (error) throw toOrderError(error, status);
  return (data ?? []).map((row) => ({
    id: row.id,
    display_name: row.display_name,
    product_name: row.product_name,
    size: row.size,
    quantity: toNumber(row.cart_qty) ?? 0,
    unit_price_usd: toNumber(row.unit_price_usd),
    line_total_usd: toNumber(row.line_total_usd),
  }));
}

// ---------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------

/** Which error a refused input is, by the field the schema named. */
function inputError(issuePath: PropertyKey | undefined): OrderError {
  if (issuePath === "total" || issuePath === "total_usd") return new OrderError("invalid_total");
  if (
    issuePath === "slotStart" ||
    issuePath === "slotEnd" ||
    issuePath === "slot_start" ||
    issuePath === "slot_end"
  ) {
    return new OrderError("invalid_window");
  }
  return new OrderError("invalid");
}

/**
 * "I placed it": records the order for a run. Returns the new order's id. The total is the
 * dollars the person says they paid. Errors: `already_confirmed` when the run has an order (the
 * database holds one per run, so two taps or two members cannot make two), `run_not_confirmable`
 * for a cart that was never approved or filled, `run_not_found` for another household's run.
 */
export async function confirmOrder(
  client: MpClient,
  runId: string,
  input: ConfirmOrderInput,
): Promise<string> {
  const parsed = ConfirmOrderInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues[0]?.path[0]);
  const value = parsed.data;

  const { data, error, status } = await client.rpc("confirm_order", {
    run_id: runId,
    total_usd: value.total,
    ...(value.modality ? { modality: value.modality } : {}),
    ...(value.slotStart ? { slot_start: value.slotStart } : {}),
    ...(value.slotEnd ? { slot_end: value.slotEnd } : {}),
    ...(value.retailerOrderId ? { retailer_order_id: value.retailerOrderId } : {}),
    ...(value.notes ? { notes: value.notes } : {}),
  });
  if (error) throw toOrderError(error, status);
  if (typeof data !== "string") throw new OrderError("unknown", "confirm_order returned no id");
  return data;
}

/** Corrects an order: the total, window, order number, notes, modality or status. */
export async function updateOrder(
  client: MpClient,
  orderId: string,
  patch: OrderPatch,
): Promise<OrderWithStore> {
  const parsed = OrderPatch.safeParse(patch);
  if (!parsed.success) throw inputError(parsed.error.issues[0]?.path[0]);
  const value = parsed.data;
  if (Object.keys(value).length === 0) throw new OrderError("invalid", "nothing to change");

  const { data, error, status } = await client
    .from("orders")
    .update(value)
    .eq("id", orderId)
    .select(ORDER_SELECT)
    .maybeSingle();
  if (error) throw toOrderError(error, status);
  // Row level security hides another household's order: the update matches nothing.
  if (!data) throw new OrderError("not_found");
  return parseOrder(data as unknown);
}

/** The status an order moves to when it arrives: picked up, or delivered. */
export function arrivedStatus(modality: Modality): OrderStatus {
  return modality === "delivery" ? "delivered" : "picked_up";
}
