// Wording for Kroger product facts in the Add-to-Cart UI. Kept apart from ProductRow so the rules
// are testable without React Native.
import type { Product } from "@mp/retailers";

/**
 * Kroger's stock level is the store's estimate. Like the fulfillment flags it does not promise
 * the item is on the shelf: Kroger confirms inventory only at checkout.
 */
export const STOCK_LABEL: Readonly<Record<Product["stockLevel"], string>> = Object.freeze({
  HIGH: "Stock level: high (confirmed at checkout)",
  LOW: "Stock level: low (confirmed at checkout)",
  TEMPORARILY_OUT_OF_STOCK: "Stock level: temporarily out (confirmed at checkout)",
  UNKNOWN: "Stock level: not reported",
});

/** Fulfillment flags mean the store is approved to offer it, not that the item is on the shelf. */
export function approvedForLabel(fulfillment: Product["fulfillment"]): string {
  const ways = [
    fulfillment.curbside ? "pickup" : null,
    fulfillment.delivery ? "delivery" : null,
    fulfillment.instore ? "in store" : null,
    fulfillment.shiptohome ? "ship to home" : null,
  ].filter((w): w is string => w !== null);
  return ways.length > 0 ? `Approved for ${ways.join(", ")}` : "No fulfillment reported";
}

/**
 * The allergen lines to show: what the product contains, then what it may contain. A "may
 * contain" allergen is never printed under "Contains", and the reverse.
 */
export function allergenLines(product: Pick<Product, "allergens" | "mayContain">): string[] {
  const may = new Set(product.mayContain);
  const contains = product.allergens.filter((name) => !may.has(name));
  const mayContain = product.allergens.filter((name) => may.has(name));
  const lines: string[] = [];
  if (contains.length > 0) lines.push(`Contains: ${contains.join(", ")}`);
  if (mayContain.length > 0) lines.push(`May contain: ${mayContain.join(", ")}`);
  return lines;
}
