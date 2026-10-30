// The shared retailer contract (WS07). docs/04-integrations.md §Adapter contract is the source.
// After WS07 merges only the orchestrator edits this file; a builder that needs a change files a
// contract change request (docs/implementation-guide.md §3.5).
//
// Relative imports in this package carry the .ts extension so Supabase Edge Functions (Deno) can
// load these modules by path. The retailer and modality vocabularies come from @mp/core
// (retail.ts), so there is one source for them.
import { AdapterModality, RetailerId as RetailerIdEnum } from "@mp/core";

/** How a store does one thing: our API call, a driven browser, a hand-off to the user, or not at all. */
export type Capability = "api" | "browser" | "handoff" | "none";

/** Every retailer the app knows, in the order of the Postgres enum `retailer`. */
export const RETAILER_IDS: readonly RetailerIdEnum[] = RetailerIdEnum.options;
export type RetailerId = RetailerIdEnum;

/** Fulfilment as this contract and Kroger's cart API spell it. Storage uses core.Modality. */
export const MODALITIES: readonly AdapterModality[] = AdapterModality.options;
export type Modality = AdapterModality;

export const STOCK_LEVELS = ["HIGH", "LOW", "TEMPORARILY_OUT_OF_STOCK", "UNKNOWN"] as const;
export type StockLevel = (typeof STOCK_LEVELS)[number];

/** Kroger banners whose consent screen and checkout we brand. */
export const BANNERS = ["qfc", "fredmeyer"] as const;
export type Banner = (typeof BANNERS)[number];

export interface Capabilities {
  search: Capability;
  cartAdd: Capability;
  cartRead: Capability;
  slots: Capability;
  checkout: Capability;
  orders: Capability;
}

export type CapabilityName = keyof Capabilities;

export interface Store {
  /** The retailer's store id (Kroger locationId, 8 characters). */
  id: string;
  retailer: RetailerId;
  /** The retailer's chain code as returned, for example "QFC" or "FRED". */
  chain: string;
  name: string;
  address: string;
  zip: string;
  lat: number;
  lng: number;
}

/**
 * One product at one store. Display fields (name, brand, size, price, promoPrice, imageUrl) are
 * exactly what the retailer returned: Kroger's terms forbid changing them (kroger/terms.ts).
 * Nothing here is ever written to a table; `cacheUntil` bounds how long it may live in memory.
 */
export interface Product {
  /** Retailer product id. Comes from the API; nothing upstream may invent one (R13). */
  id: string;
  /** 13 digits for Kroger. Null when the retailer has none. */
  upc: string | null;
  /** Displayed exactly as returned. Kroger calls this field `description`. */
  name: string;
  brand: string | null;
  size: string | null;
  /** Regular price in USD at this store. Null when the store returned none. */
  price: number | null;
  /** Promotional price in USD as returned. Null when there is no promotion. */
  promoPrice: number | null;
  /**
   * `WEIGHT` means `price` is per pound and the bought amount varies; `UNIT` means per item.
   * The line-item scorer (docs/03-ai-design.md §7) needs it for unit-price fit.
   */
  soldBy: "UNIT" | "WEIGHT" | null;
  stockLevel: StockLevel;
  /** "Approved for", not "in stock". Inventory is confirmed only at the retailer's checkout. */
  fulfillment: { instore: boolean; curbside: boolean; delivery: boolean; shiptohome: boolean };
  /**
   * Every allergen the product declares it contains or may contain, as the retailer names them.
   * Safety checks read this list: it is the conservative one. Empty when none are listed.
   */
  allergens: string[];
  /** The subset of `allergens` declared only as "may contain". Shown as "May contain", never as "Contains". */
  mayContain: string[];
  imageUrl: string | null;
  /** ISO timestamp from the response's cache headers. Past it, fetch again. */
  cacheUntil: string;
}

export interface CartItemDelta {
  productId: string;
  upc: string | null;
  /** Signed. Kroger reduces a cart line when this is negative. Never zero. */
  quantityDelta: number;
  /** Defaults to the connection's modality, then PICKUP. */
  modality?: Modality;
}

export interface CartResult {
  accepted: CartItemDelta[];
  rejected: { item: CartItemDelta; reason: string }[];
}

export interface Cart {
  items: { productId: string; quantity: number; modality: Modality }[];
  fetchedAt: string;
}

export interface Slot {
  id: string;
  start: string;
  end: string;
  modality: Modality;
  feeUsd: number | null;
}

export interface Order {
  id: string;
  placedAt: string;
  totalUsd: number;
  status: string;
}

/** What an adapter needs to act for one household member's retailer account. */
export interface ConnectionHandle {
  /** retailer_connections.id */
  connectionId: string;
  retailer: RetailerId;
  storeId: string | null;
  /** retailer_connections.modality. Cart adds use it when an item does not set its own. */
  modality?: Modality;
}

export interface ConnectContext {
  householdId: string;
  userId: string;
  redirectUri: string;
  /** Brands the Kroger consent screen. Set from the household's primary store chain. */
  banner?: Banner;
}

export interface ConnectResult {
  /** OAuth adapters: open this in the system browser. */
  authorizeUrl?: string;
  /** Adapters that need no user step (mock) return the connection at once. */
  handle?: ConnectionHandle;
}

export interface SearchOptions {
  /** At most 50 for Kroger. Defaults to the retailer's maximum. */
  limit?: number;
  brand?: string;
}

export interface FindStoresOptions {
  radiusMiles?: number;
}

export interface RetailerAdapter {
  id: RetailerId;
  capabilities: Capabilities;
  connect(ctx: ConnectContext): Promise<ConnectResult>;
  findStores(zip: string, opts?: FindStoresOptions): Promise<Store[]>;
  searchProducts(q: string, store: Store, opts?: SearchOptions): Promise<Product[]>;
  /** Batch lookup for pinned items. Missing ids are left out of the result. */
  getProducts(ids: string[], store: Store): Promise<Product[]>;
  /** Absent when `capabilities.cartRead` is 'none' (Kroger public tier). */
  getCart?(conn: ConnectionHandle): Promise<Cart>;
  addToCart(conn: ConnectionHandle, items: CartItemDelta[]): Promise<CartResult>;
  removeFromCart?(conn: ConnectionHandle, itemIds: string[]): Promise<void>;
  getSlots?(conn: ConnectionHandle, store: Store, modality: Modality): Promise<Slot[]>;
  selectSlot?(conn: ConnectionHandle, slot: Slot): Promise<void>;
  /** Tier 3 only, gated by policy and approval. `policy` is WS09's RunPolicy. */
  checkout?(conn: ConnectionHandle, policy: unknown): Promise<{ orderRef: string }>;
  getOrders?(conn: ConnectionHandle): Promise<Order[]>;
  /** Where the user finishes a Tier 1 or Tier 2 order (docs/04 §Adapter contract). */
  handoffUrl?(conn: ConnectionHandle, run?: { runId: string }): Promise<string>;
}
