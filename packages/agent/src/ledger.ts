// The write ledger for add-only carts (docs/03-ai-design.md §8, order of operations step 5).
//
// Kroger's public cart API adds and never reads. So every cart call is bracketed by two writes to
// the run item's row, and a crashed run resumes from the rows, never from the transcript:
//
//   before the call   delta_sent = cart_qty + delta, sent_at = now, delta_result = null
//   after the call    delta_result = '204' and cart_qty = delta_sent      (the retailer took it)
//                     delta_result = 'rejected: ...', cart_qty unchanged  (it refused)
//
// A row with delta_sent set and no delta_result is a call that was in flight when the worker
// died. With no way to read the cart the delta is sent again (docs/03: "a retry resumes from rows
// without a result"); with a readable cart (browser adapters, the mock) the live cart decides.
// Corrections are signed deltas: a person who lowers 2 to 1 after the push sends -1.
//
// Before any add, the push phase looks the products up again (one batch per 50) and runs the
// allergen check a third time on what the retailer returns today. Only a ProductRef minted from
// that response reaches the cart (R13).
import type { Allergen } from "@mp/core";
import {
  automates,
  type CartItemDelta,
  type ConnectionHandle,
  isRetailerError,
  type Product,
  productRef,
  type RetailerAdapter,
  RetailerAuthError,
  RetailerQuotaError,
  RetailerRequestError,
  type Store,
  toCartItemDelta,
} from "@mp/retailers";
import { checkProduct } from "./allergens.ts";
import type { ItemFlag, RunItemStatus, UserDecision } from "./types.ts";

/** The Kroger cart API answers 204; the ledger stores the same word for every accepted add. */
export const RESULT_OK = "204";
/** Kroger's getProducts takes at most 50 ids. */
export const PRODUCT_BATCH = 50;

/** One shopping_run_items row as the push phase reads it. */
export interface LedgerRow {
  id: string;
  position: number;
  displayName: string;
  productId: string | null;
  upc: string | null;
  /** The approved units. */
  qty: number | null;
  status: RunItemStatus;
  userDecision: UserDecision | null;
  /** Units the retailer confirmed in the cart from this run. */
  cartQty: number;
  deltaSent: number | null;
  deltaResult: string | null;
  sentAt: string | null;
  /** The line ingredient's ontology category, for the allergen re-check. */
  ingredientCategory?: string | null;
}

export interface LedgerStore {
  markSent(rowId: string, deltaSent: number, sentAt: string): Promise<void>;
  markResult(
    rowId: string,
    result: { cartQty: number; deltaSent: number; deltaResult: string },
  ): Promise<void>;
}

/** The units a row should have in the cart once pushed. */
export function targetQty(row: Pick<LedgerRow, "qty" | "status" | "userDecision">): number {
  if (row.userDecision === "removed") return 0;
  if (row.status !== "matched" && row.status !== "substituted") return 0;
  return Math.max(0, Math.round(row.qty ?? 0));
}

/** True when a call for this row was sent and never answered. */
export function inFlight(row: Pick<LedgerRow, "deltaSent" | "deltaResult" | "cartQty">): boolean {
  return row.deltaSent !== null && row.deltaResult === null && row.deltaSent !== row.cartQty;
}

export interface PlannedDelta {
  row: LedgerRow;
  /** Signed units to send. Never zero. */
  delta: number;
  /** The call for this exact delta was in flight when a worker died. */
  resend: boolean;
}

/**
 * The calls the push still has to make, in list order. Without a live cart: the ledger. With one
 * (`live`, product id to quantity): the retailer's own numbers, and the run never removes more of
 * a product than it added itself.
 */
export function planDeltas(
  rows: readonly LedgerRow[],
  live?: ReadonlyMap<string, number>,
): PlannedDelta[] {
  const ordered = [...rows].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  const remainingLive = live ? new Map(live) : null;
  const planned: PlannedDelta[] = [];
  for (const row of ordered) {
    if (!row.productId) continue;
    const target = targetQty(row);
    if (remainingLive) {
      const inCart = remainingLive.get(row.productId) ?? 0;
      const mine = Math.min(inCart, Math.max(target, row.cartQty, row.deltaSent ?? 0));
      remainingLive.set(row.productId, inCart - mine);
      let delta = target - mine;
      if (delta < 0) delta = Math.max(delta, -Math.max(row.cartQty, row.deltaSent ?? 0));
      if (delta !== 0) planned.push({ row, delta, resend: false });
      continue;
    }
    if (inFlight(row)) {
      const pending = (row.deltaSent ?? 0) - row.cartQty;
      planned.push({ row, delta: pending, resend: true });
      continue;
    }
    let delta = target - row.cartQty;
    if (delta < 0) delta = Math.max(delta, -row.cartQty);
    if (delta !== 0) planned.push({ row, delta, resend: false });
  }
  return planned;
}

export type PushStop = "quota" | "cancelled" | "deadline";

export interface PushOutcome {
  /** Calls the retailer accepted. */
  sent: number;
  /** Rows skipped before any call, with why (unavailable, allergen). */
  skipped: { rowId: string; flag: ItemFlag }[];
  /** Rows the retailer refused. */
  rejected: { rowId: string; flag: ItemFlag }[];
  /** Why the push stopped early, or null when it got through every row. */
  stopped: PushStop | null;
  quotaResetsAt: string | null;
}

export interface PushOptions {
  rows: readonly LedgerRow[];
  adapter: RetailerAdapter;
  connection: ConnectionHandle;
  store: Store;
  ledger: LedgerStore;
  allergies: readonly Allergen[];
  /** Called for every cart call, for the transcript. */
  record?: (call: {
    tool: string;
    input: Record<string, unknown>;
    ok: boolean;
    summary: string;
  }) => void;
  /** Checked before every call: a cancelled run or a spent clock stops the push. */
  shouldStop?: () => Promise<PushStop | null>;
  now?: () => number;
}

function toolFor(planned: PlannedDelta): string {
  if (targetQty(planned.row) === 0) return "remove_from_cart";
  return planned.row.cartQty > 0 || planned.row.deltaSent !== null ? "set_quantity" : "add_to_cart";
}

/** Looks the products up again, 50 at a time, and keeps only what the retailer returns today. */
async function refresh(
  adapter: RetailerAdapter,
  store: Store,
  ids: readonly string[],
): Promise<Map<string, Product>> {
  const out = new Map<string, Product>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += PRODUCT_BATCH) {
    for (const product of await adapter.getProducts(unique.slice(i, i + PRODUCT_BATCH), store)) {
      out.set(product.id, product);
    }
  }
  return out;
}

/**
 * Pushes the approved cart, one row per call, writing the ledger around every call. Returns when
 * every row is in the cart, or when quota, a cancel, or the clock stops it; the rows say exactly
 * where it stopped, so the next attempt picks up there.
 *
 * Throws RetailerAuthError (the connection needs a new sign-in) and errors whose outcome is
 * unknown (a dropped connection mid-call). The ledger stays as it is for the retry.
 */
export async function pushCart(options: PushOptions): Promise<PushOutcome> {
  const { adapter, connection, store, ledger, allergies } = options;
  const now = options.now ?? Date.now;
  const outcome: PushOutcome = {
    sent: 0,
    skipped: [],
    rejected: [],
    stopped: null,
    quotaResetsAt: null,
  };
  if (!automates(adapter.capabilities, "cartAdd")) {
    throw new Error(
      `push phase needs cartAdd = api or browser, ${adapter.id} has ${adapter.capabilities.cartAdd}`,
    );
  }

  let live: Map<string, number> | undefined;
  if (automates(adapter.capabilities, "cartRead") && adapter.getCart) {
    const cart = await adapter.getCart(connection);
    live = new Map();
    for (const item of cart.items)
      live.set(item.productId, (live.get(item.productId) ?? 0) + item.quantity);
    options.record?.({
      tool: "view_cart",
      input: { count: cart.items.length },
      ok: true,
      summary: `Read the cart: ${cart.items.length} lines.`,
    });
  }

  const planned = planDeltas(options.rows, live);
  const adds = planned.filter((p) => p.delta > 0 && p.row.productId);
  let products = new Map<string, Product>();
  if (adds.length > 0) {
    try {
      products = await refresh(
        adapter,
        store,
        adds.map((p) => p.row.productId ?? ""),
      );
    } catch (err) {
      if (err instanceof RetailerQuotaError) {
        return { ...outcome, stopped: "quota", quotaResetsAt: err.resetsAt };
      }
      throw err;
    }
    options.record?.({
      tool: "get_product",
      input: { count: adds.length },
      ok: true,
      summary: `Checked ${adds.length} approved products again: ${products.size} still offered.`,
    });
  }

  for (const step of planned) {
    const stop = (await options.shouldStop?.()) ?? null;
    if (stop) {
      outcome.stopped = stop;
      return outcome;
    }
    const { row } = step;
    const tool = toolFor(step);

    let delta: CartItemDelta;
    if (step.delta > 0) {
      const product = products.get(row.productId ?? "");
      if (!product || product.upc !== row.upc) {
        outcome.skipped.push({
          rowId: row.id,
          flag: {
            kind: "unavailable",
            detail: "This product is no longer offered at the store, so it was not added.",
          },
        });
        options.record?.({
          tool,
          input: { runItemId: row.id },
          ok: false,
          summary: "Skipped: the product is no longer offered.",
        });
        continue;
      }
      const verdict = checkProduct(product, allergies, {
        ingredientCategory: row.ingredientCategory,
      });
      if (verdict.blocked.length > 0) {
        outcome.skipped.push({
          rowId: row.id,
          flag: {
            kind: "allergen",
            detail: "The product now lists a household allergen, so it was not added.",
          },
        });
        options.record?.({
          tool,
          input: { runItemId: row.id },
          ok: false,
          summary: "Skipped: the allergen check refused it.",
        });
        continue;
      }
      delta = toCartItemDelta(productRef(store, product), step.delta, connection.modality);
    } else {
      // A correction or removal of a product this run already put in the cart.
      delta = {
        productId: row.productId ?? "",
        upc: row.upc,
        quantityDelta: step.delta,
        ...(connection.modality ? { modality: connection.modality } : {}),
      };
    }

    const before = row.cartQty;
    const deltaSent = before + step.delta;
    await ledger.markSent(row.id, deltaSent, new Date(now()).toISOString());

    let accepted: boolean;
    let reason = "";
    try {
      const result = await adapter.addToCart(connection, [delta]);
      accepted = result.accepted.length > 0 && result.rejected.length === 0;
      reason = result.rejected[0]?.reason ?? "";
    } catch (err) {
      if (err instanceof RetailerQuotaError) {
        await ledger.markResult(row.id, {
          cartQty: before,
          deltaSent: before,
          deltaResult: "quota",
        });
        outcome.stopped = "quota";
        outcome.quotaResetsAt = err.resetsAt;
        options.record?.({
          tool,
          input: { runItemId: row.id, delta: step.delta },
          ok: false,
          summary: "Stopped: the retailer's daily quota is spent.",
        });
        return outcome;
      }
      if (err instanceof RetailerRequestError) {
        // The retailer answered with an error, so the add did not happen.
        await ledger.markResult(row.id, {
          cartQty: before,
          deltaSent: before,
          deltaResult: `error: ${err.code}`,
        });
        options.record?.({
          tool,
          input: { runItemId: row.id, delta: step.delta },
          ok: false,
          summary: `Retailer error ${err.status}.`,
        });
        throw err;
      }
      if (err instanceof RetailerAuthError || isRetailerError(err)) throw err;
      // No answer at all: the outcome is unknown. Leave the row in flight for the retry.
      options.record?.({
        tool,
        input: { runItemId: row.id, delta: step.delta },
        ok: false,
        summary: "No answer from the retailer; will retry.",
      });
      throw err;
    }

    if (accepted) {
      await ledger.markResult(row.id, { cartQty: deltaSent, deltaSent, deltaResult: RESULT_OK });
      outcome.sent += 1;
      options.record?.({
        tool,
        input: { runItemId: row.id, delta: step.delta },
        ok: true,
        summary: `${step.resend ? "Resent" : "Sent"} ${step.delta > 0 ? "+" : ""}${step.delta}; the cart now holds ${deltaSent} from this run.`,
      });
    } else {
      const detail = `rejected: ${reason || "no reason given"}`.slice(0, 200);
      await ledger.markResult(row.id, { cartQty: before, deltaSent: before, deltaResult: detail });
      outcome.rejected.push({
        rowId: row.id,
        flag: {
          kind: "cart_rejected",
          detail: "The store would not add this item. Add it yourself in the store's app.",
        },
      });
      options.record?.({
        tool,
        input: { runItemId: row.id, delta: step.delta },
        ok: false,
        summary: "The retailer refused this add.",
      });
    }
  }
  return outcome;
}
