// Retail enums shared by the retailer adapters (WS07), the assisted-checkout host (WS08), the
// shopping agent (WS09) and history (WS12). Added by the orchestrator on WS07's contract
// change request. Two spellings exist on purpose: storage uses the lowercase Postgres enums
// from docs/02-data-model.md, and the adapter contract in docs/04-integrations.md uses the
// uppercase values Kroger's cart API takes. Convert at the boundary with the helpers below.

import { z } from "zod";

/**
 * Retailers the app knows. The Postgres enum `retailer` also holds `instacart`, retired on
 * 2026-10-30 (CCR9): Postgres cannot drop an enum value, so check constraints keep every row off
 * it and the TypeScript vocabulary no longer names it.
 */
export const RetailerId = z.enum(["kroger", "safeway", "costco"]);
export type RetailerId = z.infer<typeof RetailerId>;

/** Fulfilment as stored in `retailer_connections.modality`. */
export const Modality = z.enum(["pickup", "delivery"]);
export type Modality = z.infer<typeof Modality>;

/** Fulfilment as the `RetailerAdapter` contract and Kroger's cart API spell it. */
export const AdapterModality = z.enum(["PICKUP", "DELIVERY"]);
export type AdapterModality = z.infer<typeof AdapterModality>;

export function toAdapterModality(modality: Modality): AdapterModality {
  return modality === "pickup" ? "PICKUP" : "DELIVERY";
}

export function fromAdapterModality(modality: AdapterModality): Modality {
  return modality === "PICKUP" ? "pickup" : "delivery";
}
