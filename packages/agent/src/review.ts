// The review step (docs/03-ai-design.md §8, order of operations step 4): the person keeps, swaps,
// removes, or changes the quantity of proposed lines, and approves. Pure, with type-only imports,
// so the run-approve Edge Function (Deno) imports this file by path and applies exactly what the
// replay tests apply.
//
// A swap can only pick one of the line's own alternatives, by index: the person, like the model,
// never names a product the retailer did not return for this run.
import type { Alternative, RunItemStatus, UserDecision } from "./types.ts";

export const REVIEW_ACTIONS = ["keep", "swap", "remove", "quantity"] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

/** The most units a person may set for one line. */
export const MAX_REVIEW_QUANTITY = 24;

export interface ReviewDecision {
  runItemId: string;
  action: ReviewAction;
  alternativeIndex?: number | undefined;
  quantity?: number | undefined;
}

/** A shopping_run_items row as review reads and writes it. */
export interface ReviewableItem {
  id: string;
  status: RunItemStatus;
  productId: string | null;
  upc: string | null;
  productName: string | null;
  size: string | null;
  qty: number | null;
  unitPriceUsd: number | null;
  lineTotalUsd: number | null;
  alternatives: Alternative[] | null;
  userDecision: UserDecision | null;
}

export interface ReviewResult {
  items: ReviewableItem[];
  /** What the approved cart costs: lines going to the cart, quantity times price. */
  subtotalUsd: number;
  /** Lines that will be pushed. */
  cartLines: number;
  /** Decisions that could not apply. Any error means nothing should be written. */
  errors: string[];
}

function cents(value: number): number {
  return Math.round(value * 100) / 100;
}

function total(qty: number | null, price: number | null): number | null {
  return qty === null || price === null ? null : cents(qty * price);
}

/** True when the line will go in the cart. */
export function goesToCart(
  item: Pick<ReviewableItem, "status" | "userDecision" | "productId">,
): boolean {
  return (
    item.productId !== null &&
    (item.status === "matched" || item.status === "substituted") &&
    item.userDecision !== "removed"
  );
}

/**
 * Applies the person's decisions in order, then accepts every line with a product that got no
 * decision. Returns errors instead of throwing, so the caller can answer 400 and write nothing.
 */
export function applyReview(
  items: readonly ReviewableItem[],
  decisions: readonly ReviewDecision[],
): ReviewResult {
  const byId = new Map(
    items.map((item) => [
      item.id,
      { ...item, alternatives: item.alternatives ? [...item.alternatives] : null },
    ]),
  );
  const errors: string[] = [];
  const decided = new Set<string>();

  for (const decision of decisions) {
    const item = byId.get(decision.runItemId);
    if (!item) {
      errors.push(`unknown_item:${decision.runItemId}`);
      continue;
    }
    decided.add(item.id);
    switch (decision.action) {
      case "keep": {
        if (!item.productId || item.status === "removed" || item.status === "unmatched") {
          errors.push(`nothing_to_keep:${item.id}`);
          break;
        }
        if (item.userDecision === null) item.userDecision = "accepted";
        break;
      }
      case "remove": {
        item.userDecision = "removed";
        item.status = item.productId ? "removed" : item.status;
        item.lineTotalUsd = item.productId ? 0 : item.lineTotalUsd;
        break;
      }
      case "swap": {
        const index = decision.alternativeIndex;
        const alternatives = item.alternatives ?? [];
        const alt =
          Number.isInteger(index) && index !== undefined ? alternatives[index] : undefined;
        if (!alt) {
          errors.push(`unknown_alternative:${item.id}`);
          break;
        }
        // The product given up becomes an alternative, so the person can swap back.
        const previous: Alternative | null =
          item.productId && item.productName
            ? {
                product_id: item.productId,
                upc: item.upc,
                name: item.productName,
                size: item.size,
                price: item.unitPriceUsd,
                qty: item.qty ?? 1,
              }
            : null;
        item.alternatives = alternatives
          .filter((_, i) => i !== index)
          .concat(previous ? [previous] : [])
          .slice(0, 3);
        item.productId = alt.product_id;
        item.upc = alt.upc;
        item.productName = alt.name;
        item.size = alt.size;
        item.unitPriceUsd = alt.price;
        item.qty = alt.qty;
        item.lineTotalUsd = total(alt.qty, alt.price);
        item.status = item.status === "substituted" ? "substituted" : "matched";
        item.userDecision = "swapped";
        break;
      }
      case "quantity": {
        const quantity = decision.quantity;
        if (
          quantity === undefined ||
          !Number.isInteger(quantity) ||
          quantity < 1 ||
          quantity > MAX_REVIEW_QUANTITY
        ) {
          errors.push(`invalid_quantity:${item.id}`);
          break;
        }
        if (!item.productId || item.status === "unmatched" || item.status === "removed") {
          errors.push(`nothing_to_change:${item.id}`);
          break;
        }
        item.qty = quantity;
        item.lineTotalUsd = total(quantity, item.unitPriceUsd);
        if (item.userDecision === null || item.userDecision === "removed")
          item.userDecision = "accepted";
        break;
      }
    }
  }

  for (const item of byId.values()) {
    if (!decided.has(item.id) && item.userDecision === null && goesToCart(item)) {
      item.userDecision = "accepted";
    }
  }

  const reviewed = items.map((item) => byId.get(item.id) as ReviewableItem);
  const cart = reviewed.filter(goesToCart);
  return {
    items: reviewed,
    subtotalUsd: cents(cart.reduce((sum, item) => sum + (item.lineTotalUsd ?? 0), 0)),
    cartLines: cart.length,
    errors,
  };
}
