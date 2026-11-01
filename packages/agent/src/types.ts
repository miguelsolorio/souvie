// Shapes the shopping agent works with. Host-agnostic: nothing here touches a database, a network
// or a Node API. A host (the WS09 worker, the WS08 WebView host) loads these from its own storage
// and hands them in; the agent hands back a proposal, a ledger, and a transcript.
//
// Retailer data in these shapes (Product, Alternative, the product on a ProposedItem) is exactly
// what the adapter returned. The agent never edits a name, a size or a price (Kroger terms).
import type { Allergen, RunPolicy } from "@mp/core";
import type { ConnectionHandle, Store } from "@mp/retailers";

// ---------------------------------------------------------------------------------------
// Vocabularies (the Postgres enums of the runs migration)
// ---------------------------------------------------------------------------------------

export const RUN_STATUSES = [
  "queued",
  "running",
  "needs_review",
  "cart_ready",
  "checking_out",
  "checked_out",
  "failed",
  "cancelled",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_ITEM_STATUSES = [
  "proposed",
  "matched",
  "substituted",
  "unmatched",
  "removed",
] as const;
export type RunItemStatus = (typeof RUN_ITEM_STATUSES)[number];

export const USER_DECISIONS = ["accepted", "swapped", "removed"] as const;
export type UserDecision = (typeof USER_DECISIONS)[number];

/** Why a line needs the person's call at review. Each is set by code, never by the model. */
export const ITEM_FLAG_KINDS = [
  /** A candidate listed a household allergen and was dropped. */
  "allergen",
  /** The product says it may contain, or does not declare, a household allergen. */
  "allergen_may_contain",
  /** No allergen data where the ingredient or name points at a household allergen. */
  "allergen_data_missing",
  /** The retailer named an allergen we have no rule for. */
  "allergen_unknown",
  /** The line total is over the per-item ceiling. */
  "over_item_ceiling",
  /** The chosen product is not the pinned or usual one. */
  "substitution",
  /** No candidate carries the line's qualifier ("gluten-free"). */
  "qualifier",
  /** The list line itself was unparsed or ambiguous. */
  "needs_attention",
  /** The top candidates were too close to call, or the model was unsure. */
  "low_confidence",
  /** Nothing in stock. */
  "out_of_stock",
  /** The pinned product is gone or unsafe now. */
  "pinned_unavailable",
  /** No usable candidate. */
  "unmatched",
  /** The retailer's daily quota stopped the search. */
  "quota",
  /** No model was available, so code picked. */
  "model_unavailable",
  /** The run hit max_tool_calls or max_wall_clock_seconds before the model chose. */
  "limit_reached",
  /** The retailer refused the cart add. */
  "cart_rejected",
  /** At push time the product was no longer offered. */
  "unavailable",
] as const;
export type ItemFlagKind = (typeof ITEM_FLAG_KINDS)[number];

export interface ItemFlag {
  kind: ItemFlagKind;
  /** One plain sentence for the review screen. Names list lines, never product data. */
  detail: string;
}

export const RUN_FLAG_KINDS = [
  "budget",
  "quota",
  "model_unavailable",
  "limit_reached",
  "allergen_removed",
  "cart_rejected",
] as const;
export type RunFlagKind = (typeof RUN_FLAG_KINDS)[number];

export interface RunFlag {
  kind: RunFlagKind;
  detail: string;
}

// ---------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------

/** The ontology fields the scorer reads for unit conversion. */
export interface LineIngredient {
  id: string;
  name: string;
  /** ingredients.category: produce, dairy, seafood, ... */
  category: string;
  defaultUnit: string;
  densityGPerMl: number | null;
  typicalUnitWeightG: number | null;
}

/** One grocery list line the run shops for (excluded_reason null, checked false). */
export interface ListLine {
  /** grocery_list_items.id */
  id: string;
  displayName: string;
  qty: number | null;
  unit: string | null;
  section: string;
  position: number;
  /** Null for a free-text line. Such a line goes to the model as raw text and is flagged. */
  ingredient: LineIngredient | null;
  /** "gluten-free", "unsalted". A candidate must carry each in its name. */
  qualifiers: string[];
  needsAttention: boolean;
  /** The recipe lines behind the amount (detail.contributions[].rawTexts), for pack-size fit. */
  rawTexts: string[];
}

/** A household's confirmed product for an ingredient at this store (product_matches). */
export interface ProductChoice {
  ingredientId: string;
  productId: string;
  upc: string | null;
  productName: string;
  size: string | null;
  /** "Always this": the top scoring factor. */
  pinned: boolean;
  lastChosenAt: string;
}

/**
 * Soft shopping preferences from the members' profiles. Unknown to ProfilePreferences today, so
 * the host reads them leniently (see `readShoppingPreferences`); empty means no preference.
 */
export interface ShoppingPreferences {
  preferredBrands: string[];
  avoidBrands: string[];
  preferOrganic: boolean;
}

export const NO_PREFERENCES: ShoppingPreferences = Object.freeze({
  preferredBrands: [],
  avoidBrands: [],
  preferOrganic: false,
}) as ShoppingPreferences;

/** Everything one run needs. The host builds it; the agent only reads it. */
export interface RunContext {
  runId: string;
  householdId: string;
  store: Store;
  connection: ConnectionHandle;
  policy: RunPolicy;
  lines: ListLine[];
  /** product_matches rows for these lines' ingredients at this store. */
  choices: ProductChoice[];
  /** The union of every member's allergies (members who never answered add none). */
  allergies: Allergen[];
  preferences: ShoppingPreferences;
}

// ---------------------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------------------

/** A product as a run item stores it: what the retailer returned, nothing derived. */
export interface ChosenProduct {
  productId: string;
  upc: string | null;
  name: string;
  brand: string | null;
  size: string | null;
  /** promoPrice when there is one, else price. Null when the store sent no price. */
  price: number | null;
}

/** One alternative shown at review (shopping_run_items.alternatives). */
export interface Alternative {
  product_id: string;
  upc: string | null;
  name: string;
  size: string | null;
  price: number | null;
  /** Units to buy if the person swaps to it. */
  qty: number;
}

/** One shopping_run_items row as the planner proposes it. */
export interface ProposedItem {
  /** shopping_run_items.id. The host assigns it before writing, so the ledger can name it. */
  id: string;
  listItemId: string;
  position: number;
  displayName: string;
  section: string;
  ingredientId: string | null;
  product: ChosenProduct | null;
  /** Whole units for the cart. Null while unmatched. */
  qty: number | null;
  unitPriceUsd: number | null;
  lineTotalUsd: number | null;
  status: RunItemStatus;
  alternatives: Alternative[];
  flags: ItemFlag[];
  reason: string | null;
}

/** shopping_runs.cart_snapshot. Cleared 24 hours after the run closes. */
export interface CartSnapshot {
  version: 1;
  storeName: string;
  generatedAt: string;
  itemCount: number;
  matchedCount: number;
  needsReviewCount: number;
  subtotalUsd: number;
  flags: RunFlag[];
  /** A short line for the top of the review screen. Names no products. */
  summary: string;
  /** Where the person pays (Tier 1). Set when the run reaches cart_ready. */
  handoffUrl?: string;
  /** The retailer's order reference after a Tier 3 checkout. */
  orderRef?: string;
}

/** shopping_runs.progress */
export interface RunProgress {
  phase: "planning" | "reviewing" | "pushing" | "checkout" | "done";
  done: number;
  total: number;
}

/** One tool call, as shopping_runs.transcript keeps it. No product names, prices or ids. */
export interface TranscriptEntry {
  ts: string;
  tool: string;
  /** Who asked for the call: the host's own code or the model. */
  by: "host" | "model";
  input: Record<string, unknown>;
  output_summary: string;
  ok: boolean;
  screenshot_path?: string;
}

/** Push notification payloads (the app routes on `type`). */
export type PushPayload =
  | { type: "cart_ready"; runId: string; storeName: string; subtotalUsd: number }
  | { type: "needs_review"; runId: string; count: number };
