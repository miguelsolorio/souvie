// Pure logic for the shopping run screens (WS09): row parsing, status copy, the review draft, and
// grouping by section. No React Native here, so Vitest runs it.
//
// The review preview runs the same applyReview the run-approve function runs, so the subtotal the
// person sees before tapping "Approve" is the one the server checks against the budget.
import { applyReview, type ReviewableItem, type ReviewDecision } from "@mp/agent/review";
import { groupBySection as groupSections, type SectionGroup } from "@mp/core";

export type RunStatus =
  | "queued"
  | "running"
  | "needs_review"
  | "cart_ready"
  | "checking_out"
  | "checked_out"
  | "failed"
  | "cancelled";

export interface RunFlag {
  kind: string;
  detail: string;
}

export interface RunSnapshot {
  storeName?: string;
  summary?: string;
  itemCount?: number;
  matchedCount?: number;
  needsReviewCount?: number;
  subtotalUsd?: number;
  flags?: RunFlag[];
  handoffUrl?: string;
}

export interface TranscriptEntry {
  ts: string;
  tool: string;
  by: "host" | "model";
  output_summary: string;
  ok: boolean;
}

/** A shopping_runs row as the app reads it. */
export interface ShoppingRun {
  id: string;
  household_id: string;
  list_id: string;
  retailer: string;
  store_name: string | null;
  trigger: "manual" | "scheduled";
  status: RunStatus;
  cart_snapshot: RunSnapshot | null;
  subtotal_usd: number | null;
  transcript: TranscriptEntry[];
  error: string | null;
  progress: { phase?: string; done?: number; total?: number } | null;
  approved_at: string | null;
  policy: { budget_cap_usd?: number | null; per_item_ceiling_usd?: number | null } | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface Alternative {
  product_id: string;
  upc: string | null;
  name: string;
  size: string | null;
  price: number | null;
  qty: number;
}

/** A shopping_run_items row as the app reads it. */
export interface RunItem {
  id: string;
  run_id: string;
  position: number;
  display_name: string;
  section: string;
  product_id: string | null;
  upc: string | null;
  product_name: string | null;
  size: string | null;
  qty: number | null;
  unit_price_usd: number | null;
  line_total_usd: number | null;
  status: ReviewableItem["status"];
  alternatives: Alternative[] | null;
  user_decision: ReviewableItem["userDecision"];
  flags: RunFlag[];
  reason: string | null;
  cart_qty: number;
  delta_result: string | null;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** numeric columns arrive as strings from PostgREST; normalize them. */
export function toRun(row: Record<string, unknown>): ShoppingRun {
  return {
    ...(row as unknown as ShoppingRun),
    subtotal_usd: num(row.subtotal_usd),
    transcript: Array.isArray(row.transcript) ? (row.transcript as TranscriptEntry[]) : [],
    cart_snapshot: (row.cart_snapshot as RunSnapshot | null) ?? null,
  };
}

/**
 * Lays a Realtime change over the cached run. Only the keys the payload carries change: a payload
 * that leaves out an unchanged column (Postgres can omit a large unchanged value) keeps the cached
 * transcript and snapshot instead of wiping them.
 */
export function overlayRun(held: ShoppingRun, row: Record<string, unknown>): ShoppingRun {
  const next = { ...held } as ShoppingRun & Record<string, unknown>;
  for (const [key, value] of Object.entries(row)) next[key] = value;
  if ("subtotal_usd" in row) next.subtotal_usd = num(row.subtotal_usd);
  if ("transcript" in row) {
    next.transcript = Array.isArray(row.transcript)
      ? (row.transcript as TranscriptEntry[])
      : held.transcript;
  }
  if ("cart_snapshot" in row)
    next.cart_snapshot = (row.cart_snapshot as RunSnapshot | null) ?? null;
  return next;
}

export function toItem(row: Record<string, unknown>): RunItem {
  return {
    ...(row as unknown as RunItem),
    qty: num(row.qty),
    unit_price_usd: num(row.unit_price_usd),
    line_total_usd: num(row.line_total_usd),
    cart_qty: num(row.cart_qty) ?? 0,
    flags: Array.isArray(row.flags) ? (row.flags as RunFlag[]) : [],
    alternatives: Array.isArray(row.alternatives) ? (row.alternatives as Alternative[]) : null,
  };
}

export const ACTIVE: readonly RunStatus[] = [
  "queued",
  "running",
  "needs_review",
  "cart_ready",
  "checking_out",
];

export function isActive(status: RunStatus): boolean {
  return ACTIVE.includes(status);
}

/** The status in a few words, for the chip on the list and the detail header. */
export const STATUS_LABEL: Readonly<Record<RunStatus, string>> = {
  queued: "Waiting to start",
  running: "Shopping",
  needs_review: "Ready for your review",
  cart_ready: "Cart ready",
  checking_out: "Checking out",
  checked_out: "Order placed",
  failed: "Stopped",
  cancelled: "Cancelled",
};

/** Lines the store confirmed in the cart. */
export function inCartCount(items: readonly Pick<RunItem, "cart_qty">[]): number {
  return items.filter((item) => item.cart_qty > 0).length;
}

/** The line under the status: what is happening now. */
export function progressText(
  run: Pick<ShoppingRun, "status" | "progress" | "approved_at" | "error">,
  options: { itemsInCart?: boolean } = {},
): string {
  const done = run.progress?.done ?? 0;
  const total = run.progress?.total ?? 0;
  switch (run.status) {
    case "queued":
      return run.approved_at
        ? "Approved. Waiting to fill your cart."
        : "Waiting for the shopper to start.";
    case "running":
      if (run.approved_at) {
        return total > 0
          ? `Adding to your cart: ${Math.min(done, total)} of ${total}.`
          : "Adding to your cart.";
      }
      return total > 0
        ? `Finding products: ${Math.min(done, total)} of ${total} items.`
        : "Finding products.";
    case "needs_review":
      return "Check the cart, change anything you like, then approve. Nothing is in your store cart yet.";
    case "cart_ready":
      return "Your store cart is filled. Pick a time and pay in the store's app.";
    case "checking_out":
      return "Placing the order.";
    case "checked_out":
      return "The order is placed.";
    case "failed":
      return failureText(run.error, options.itemsInCart);
    case "cancelled":
      return "This run was cancelled.";
  }
}

/**
 * A failure in plain words. The raw error stays in the transcript. When the run already put items
 * in the store cart, a new run starts from an empty ledger and would add them again, so say so.
 */
export function failureText(error: string | null, itemsInCart = false): string {
  const text = failureReason(error);
  return itemsInCart
    ? `${text} Some items may already be in your store cart, so check it first.`
    : text;
}

function failureReason(error: string | null): string {
  if (!error) return "The shopper stopped. Try again.";
  if (error.startsWith("needs_reauth"))
    return "Your store account needs a new sign-in. Reconnect it, then try again.";
  // The kill switch (WS15): the worker fails a claimable run with agent_disabled while
  // shopping_agent_enabled is off. Same words as ShopThisList shows before a run starts.
  if (error.startsWith("agent_disabled"))
    return "Shopping is paused right now. Your list is safe. Try again later.";
  if (error.startsWith("stalled")) return "The shopper stopped answering. Try again.";
  if (error.startsWith("connection_")) return "Check your store connection, then try again.";
  return "The shopper could not finish this run. Try again.";
}

export function money(value: number | null | undefined): string {
  return value === null || value === undefined ? "" : `$${value.toFixed(2)}`;
}

// ---------------------------------------------------------------------------------------
// The review draft
// ---------------------------------------------------------------------------------------

/** What the person changed on one line. Absent lines are kept as proposed. */
export type LineEdit =
  | { action: "swap"; alternativeIndex: number; quantity?: number }
  | { action: "remove" }
  | { action: "quantity"; quantity: number };

export type ReviewDraft = Readonly<Record<string, LineEdit>>;

export function swap(draft: ReviewDraft, itemId: string, alternativeIndex: number): ReviewDraft {
  const current = draft[itemId];
  if (current?.action === "swap" && current.alternativeIndex === alternativeIndex) {
    const { [itemId]: _dropped, ...rest } = draft;
    return rest;
  }
  return { ...draft, [itemId]: { action: "swap", alternativeIndex } };
}

export function remove(draft: ReviewDraft, itemId: string): ReviewDraft {
  return { ...draft, [itemId]: { action: "remove" } };
}

export function restore(draft: ReviewDraft, itemId: string): ReviewDraft {
  const { [itemId]: _dropped, ...rest } = draft;
  return rest;
}

export function setQuantity(draft: ReviewDraft, itemId: string, quantity: number): ReviewDraft {
  const current = draft[itemId];
  if (current?.action === "swap") return { ...draft, [itemId]: { ...current, quantity } };
  return { ...draft, [itemId]: { action: "quantity", quantity } };
}

/** The decisions run-approve takes, in line order. */
export function toDecisions(items: readonly RunItem[], draft: ReviewDraft): ReviewDecision[] {
  const out: ReviewDecision[] = [];
  for (const item of items) {
    const edit = draft[item.id];
    if (!edit) continue;
    if (edit.action === "swap") {
      out.push({ runItemId: item.id, action: "swap", alternativeIndex: edit.alternativeIndex });
      if (edit.quantity !== undefined)
        out.push({ runItemId: item.id, action: "quantity", quantity: edit.quantity });
    } else if (edit.action === "remove") {
      out.push({ runItemId: item.id, action: "remove" });
    } else {
      out.push({ runItemId: item.id, action: "quantity", quantity: edit.quantity });
    }
  }
  return out;
}

export function toReviewable(item: RunItem): ReviewableItem {
  return {
    id: item.id,
    status: item.status,
    productId: item.product_id,
    upc: item.upc,
    productName: item.product_name,
    size: item.size,
    qty: item.qty,
    unitPriceUsd: item.unit_price_usd,
    lineTotalUsd: item.line_total_usd,
    alternatives: item.alternatives,
    userDecision: item.user_decision,
  };
}

export interface ReviewPreview {
  /** Each line as it will be approved. */
  items: Map<string, ReviewableItem>;
  subtotalUsd: number;
  cartLines: number;
  errors: string[];
}

/** The cart as approving now would leave it: the same applyReview the server runs. */
export function preview(items: readonly RunItem[], draft: ReviewDraft): ReviewPreview {
  const result = applyReview(items.map(toReviewable), toDecisions(items, draft));
  return {
    items: new Map(result.items.map((item) => [item.id, item])),
    subtotalUsd: result.subtotalUsd,
    cartLines: result.cartLines,
    errors: result.errors,
  };
}

/** Lines grouped by store section, in the default aisle order, then by position. */
export function groupBySection(items: readonly RunItem[]): SectionGroup<RunItem>[] {
  return groupSections([...items].sort((a, b) => a.position - b.position));
}

/** Over the cap: the approve button says so instead of failing on the server. */
export function overBudget(
  subtotalUsd: number,
  policy: { budget_cap_usd?: number | null } | null,
): number | null {
  const cap = policy?.budget_cap_usd;
  return typeof cap === "number" && subtotalUsd > cap ? cap : null;
}

/** Transcript lines for the viewer, newest last, with a readable time. */
export function transcriptLines(
  entries: readonly TranscriptEntry[],
): Array<{ key: string; time: string; who: string; tool: string; text: string; ok: boolean }> {
  return entries.map((entry, i) => ({
    key: `${i}-${entry.ts}`,
    time: entry.ts.slice(11, 19),
    who: entry.by === "model" ? "Assistant" : "Shopper",
    tool: entry.tool.replace(/_/g, " "),
    text: entry.output_summary,
    ok: entry.ok,
  }));
}
