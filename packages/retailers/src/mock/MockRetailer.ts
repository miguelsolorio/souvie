// MockRetailer: a deterministic stand-in for any retailer, for tests, evals, and WS09 run replays.
//
// Every capability is 'api', so every agent path can run against it. Results depend only on the
// fixtures, the seed, and the store: the same inputs always give the same products, prices,
// stock, and order. Failures and latency are configurable per operation. The cart is in memory
// and readable, unlike Kroger's.
//
// Fixture products are fictional (brands such as "Harbor Fields" and "Mock Market"); none of it
// came from a retailer API.
import { MOCK_CAPABILITIES } from "../capabilities.ts";
import {
  RetailerAuthError,
  RetailerError,
  RetailerNotSupportedError,
  RetailerQuotaError,
  RetailerRequestError,
} from "../errors.ts";
import type {
  Cart,
  CartItemDelta,
  CartResult,
  ConnectContext,
  ConnectionHandle,
  ConnectResult,
  FindStoresOptions,
  Modality,
  Order,
  Product,
  RetailerAdapter,
  RetailerId,
  SearchOptions,
  Slot,
  StockLevel,
  Store,
} from "../types.ts";
import productFixtures from "./fixtures/products.json";
import storeFixtures from "./fixtures/stores.json";

export type MockCategory = "produce" | "dairy" | "meat" | "pantry" | "frozen";

export interface MockProductFixture {
  id: string;
  upc: string;
  name: string;
  brand: string | null;
  size: string;
  /** Base price; each store varies it deterministically. */
  price: number;
  soldBy: "UNIT" | "WEIGHT";
  category: MockCategory;
  allergens: string[];
}

export type MockStoreFixture = Omit<Store, "retailer">;

export const MOCK_PRODUCTS: readonly MockProductFixture[] = productFixtures as MockProductFixture[];
export const MOCK_STORES: readonly MockStoreFixture[] = storeFixtures;

export type MockOperation =
  | "connect"
  | "findStores"
  | "searchProducts"
  | "getProducts"
  | "getCart"
  | "addToCart"
  | "removeFromCart"
  | "getSlots"
  | "selectSlot"
  | "checkout"
  | "getOrders"
  | "handoffUrl";

/** What a failing operation throws: the typed errors callers must handle, or a plain outage. */
export type MockFailure = "auth" | "quota" | "not_supported" | "network";

export interface MockRetailerOptions {
  /** Which retailer the mock stands in for. Defaults to kroger. */
  id?: RetailerId;
  /** Changes tie-break order, per-store prices, promotions, and stock. Defaults to 1. */
  seed?: number;
  /** Fixed delay, or a seeded range, before every operation. */
  latencyMs?: number | { min: number; max: number };
  /** Operations that always fail, and how. */
  failures?: Partial<Record<MockOperation, MockFailure>>;
  /** Seeded random failures across operations, for chaos tests. */
  failureRate?: { rate: number; failure: MockFailure; operations?: MockOperation[] };
  /** How long returned products stay fresh, in seconds. Defaults to 300. */
  cacheSeconds?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** FNV-1a, 32 bit, scaled to [0, 1). Stable across runtimes. */
export function hashUnit(...parts: (string | number)[]): number {
  let h = 0x811c9dc5;
  for (const char of parts.join("\u0000")) {
    h ^= char.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h / 0x1_0000_0000;
}

/** mulberry32: a small seeded PRNG for failure injection. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

const STOP_WORDS = new Set(["a", "an", "and", "of", "the", "with", "for", "fresh"]);

/** Lowercase word stems: "Thighs" and "thigh" match, "tomatoes" and "tomato" match. */
function stems(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9%]+/)
    .filter((w) => w.length > 0 && !STOP_WORDS.has(w))
    .map((w) => w.replace(/(es|s)$/, ""));
}

function cents(value: number): number {
  return Math.round(value * 100) / 100;
}

interface CartLine {
  quantity: number;
  modality: Modality;
}

export class MockRetailer implements RetailerAdapter {
  readonly id: RetailerId;
  readonly capabilities = MOCK_CAPABILITIES;
  /** Every operation in order, for replay assertions. */
  readonly calls: { operation: MockOperation; at: number }[] = [];

  readonly #seed: number;
  readonly #options: MockRetailerOptions;
  readonly #failures = new Map<MockOperation, MockFailure>();
  readonly #random: () => number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #byId = new Map<string, MockProductFixture>();
  readonly #carts = new Map<string, Map<string, CartLine>>();
  readonly #selectedSlots = new Map<string, Slot>();
  readonly #orders = new Map<string, Order[]>();
  readonly #stores: Store[];

  constructor(options: MockRetailerOptions = {}) {
    this.id = options.id ?? "kroger";
    this.#seed = options.seed ?? 1;
    this.#options = options;
    this.#random = prng(this.#seed);
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    for (const [op, failure] of Object.entries(options.failures ?? {})) {
      if (failure) this.#failures.set(op as MockOperation, failure);
    }
    for (const p of MOCK_PRODUCTS) this.#byId.set(p.id, p);
    this.#stores = MOCK_STORES.map((s) => Object.freeze({ ...s, retailer: this.id }));
  }

  /** Makes `operation` fail with `failure` from now on, or stop failing when null. */
  setFailure(operation: MockOperation, failure: MockFailure | null): void {
    if (failure) this.#failures.set(operation, failure);
    else this.#failures.delete(operation);
  }

  /** Empties carts, slots, orders, and the call log. Fixtures and failures stay. */
  reset(): void {
    this.#carts.clear();
    this.#selectedSlots.clear();
    this.#orders.clear();
    this.calls.length = 0;
  }

  async #enter(operation: MockOperation): Promise<void> {
    this.calls.push({ operation, at: this.#now() });
    const latency = this.#options.latencyMs;
    if (typeof latency === "number" && latency > 0) await this.#sleep(latency);
    else if (latency && typeof latency === "object") {
      await this.#sleep(latency.min + Math.floor(this.#random() * (latency.max - latency.min + 1)));
    }
    let failure = this.#failures.get(operation);
    const rate = this.#options.failureRate;
    if (!failure && rate && (!rate.operations || rate.operations.includes(operation))) {
      if (this.#random() < rate.rate) failure = rate.failure;
    }
    if (failure) throw this.#error(operation, failure);
  }

  #error(operation: MockOperation, failure: MockFailure): Error {
    switch (failure) {
      case "auth":
        return new RetailerAuthError(this.id, "unauthorized", `mock ${operation}: unauthorized`, {
          needsReauth: true,
        });
      case "quota": {
        const now = new Date(this.#now());
        const reset = new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
        );
        return new RetailerQuotaError(this.id, operation, 9_500, 10_000, reset.toISOString());
      }
      case "not_supported":
        return new RetailerNotSupportedError(this.id, operation);
      case "network":
        return new RetailerRequestError(this.id, 503, `mock ${operation}: service unavailable`);
    }
  }

  #product(fixture: MockProductFixture, store: Store): Product {
    const h = (salt: string) => hashUnit(this.#seed, store.id, fixture.id, salt);
    const price = cents(fixture.price * (0.9 + 0.2 * h("price")));
    const promo = h("promo") < 0.2 ? cents(price * 0.8) : null;
    const stockRoll = h("stock");
    const stockLevel: StockLevel =
      stockRoll < 0.05 ? "TEMPORARILY_OUT_OF_STOCK" : stockRoll < 0.2 ? "LOW" : "HIGH";
    const product: Product = {
      id: fixture.id,
      upc: fixture.upc,
      name: fixture.name,
      brand: fixture.brand,
      size: fixture.size,
      price,
      promoPrice: promo,
      soldBy: fixture.soldBy,
      stockLevel,
      fulfillment: Object.freeze({
        instore: true,
        curbside: true,
        delivery: true,
        shiptohome: fixture.category === "pantry",
      }),
      allergens: Object.freeze([...fixture.allergens]) as string[],
      mayContain: Object.freeze([] as string[]) as string[],
      imageUrl: null,
      cacheUntil: new Date(this.#now() + (this.#options.cacheSeconds ?? 300) * 1000).toISOString(),
    };
    return Object.freeze(product);
  }

  #store(storeId: string | null): Store {
    const store = this.#stores.find((s) => s.id === storeId) ?? this.#stores[0];
    if (!store) throw new RetailerError(this.id, "no_store", "The mock has no stores");
    return store;
  }

  async connect(ctx: ConnectContext): Promise<ConnectResult> {
    await this.#enter("connect");
    return {
      handle: {
        connectionId: `mock-${ctx.householdId}-${ctx.userId}`,
        retailer: this.id,
        storeId: null,
        modality: "PICKUP",
      },
    };
  }

  /** Every mock store, the one in `zip` first. `radiusMiles` under 1 returns only exact matches. */
  async findStores(zip: string, opts: FindStoresOptions = {}): Promise<Store[]> {
    await this.#enter("findStores");
    const exact = this.#stores.filter((s) => s.zip === zip.trim());
    if ((opts.radiusMiles ?? 10) < 1) return exact;
    return [...exact, ...this.#stores.filter((s) => s.zip !== zip.trim())];
  }

  /**
   * Products whose name or category contains every word of the query (stemmed). When none
   * match every word, products matching the most words. Ties break by a seeded hash.
   */
  async searchProducts(q: string, store: Store, opts: SearchOptions = {}): Promise<Product[]> {
    await this.#enter("searchProducts");
    const wanted = [...new Set(stems(q))];
    if (wanted.length === 0) return [];
    const limit = Math.max(1, Math.min(50, Math.trunc(opts.limit ?? 50)));
    const brand = opts.brand?.toLowerCase();

    const scored = MOCK_PRODUCTS.filter((p) => !brand || p.brand?.toLowerCase() === brand)
      .map((p) => {
        const words = new Set(stems(`${p.name} ${p.category}`));
        return { p, score: wanted.filter((w) => words.has(w)).length };
      })
      .filter((s) => s.score > 0);
    const best = Math.max(0, ...scored.map((s) => s.score));
    const floor = best === wanted.length ? wanted.length : best;
    return scored
      .filter((s) => s.score >= floor)
      .sort(
        (a, b) =>
          b.score - a.score ||
          hashUnit(this.#seed, q, a.p.id) - hashUnit(this.#seed, q, b.p.id) ||
          a.p.id.localeCompare(b.p.id),
      )
      .slice(0, limit)
      .map((s) => this.#product(s.p, store));
  }

  async getProducts(ids: string[], store: Store): Promise<Product[]> {
    await this.#enter("getProducts");
    return [...new Set(ids)]
      .map((id) => this.#byId.get(id))
      .filter((p): p is MockProductFixture => p !== undefined)
      .map((p) => this.#product(p, store));
  }

  #cart(conn: ConnectionHandle): Map<string, CartLine> {
    let cart = this.#carts.get(conn.connectionId);
    if (!cart) {
      cart = new Map();
      this.#carts.set(conn.connectionId, cart);
    }
    return cart;
  }

  async getCart(conn: ConnectionHandle): Promise<Cart> {
    await this.#enter("getCart");
    return {
      items: [...this.#cart(conn)].map(([productId, line]) => ({
        productId,
        quantity: line.quantity,
        modality: line.modality,
      })),
      fetchedAt: new Date(this.#now()).toISOString(),
    };
  }

  /** Applies signed deltas. A line that reaches zero or below is removed. */
  async addToCart(conn: ConnectionHandle, items: CartItemDelta[]): Promise<CartResult> {
    await this.#enter("addToCart");
    const cart = this.#cart(conn);
    const result: CartResult = { accepted: [], rejected: [] };
    for (const item of items) {
      if (!Number.isInteger(item.quantityDelta) || item.quantityDelta === 0) {
        result.rejected.push({ item, reason: "quantityDelta must be a non-zero integer" });
        continue;
      }
      const fixture = this.#byId.get(item.productId);
      if (!fixture || (item.upc !== null && item.upc !== fixture.upc)) {
        result.rejected.push({ item, reason: "unknown product" });
        continue;
      }
      const current = cart.get(item.productId);
      const quantity = (current?.quantity ?? 0) + item.quantityDelta;
      if (quantity <= 0) cart.delete(item.productId);
      else {
        cart.set(item.productId, {
          quantity,
          modality: item.modality ?? conn.modality ?? current?.modality ?? "PICKUP",
        });
      }
      result.accepted.push(item);
    }
    return result;
  }

  async removeFromCart(conn: ConnectionHandle, itemIds: string[]): Promise<void> {
    await this.#enter("removeFromCart");
    const cart = this.#cart(conn);
    for (const id of itemIds) cart.delete(id);
  }

  #slots(store: Store, modality: Modality): Slot[] {
    const hour = 60 * 60 * 1000;
    const first = Math.ceil(this.#now() / hour) * hour + hour;
    return Array.from({ length: 6 }, (_, i) => ({
      id: `${store.id}-${modality}-${i}`,
      start: new Date(first + i * 2 * hour).toISOString(),
      end: new Date(first + (i * 2 + 2) * hour).toISOString(),
      modality,
      feeUsd: modality === "DELIVERY" ? 9.95 : 0,
    }));
  }

  async getSlots(_conn: ConnectionHandle, store: Store, modality: Modality): Promise<Slot[]> {
    await this.#enter("getSlots");
    return this.#slots(store, modality);
  }

  async selectSlot(conn: ConnectionHandle, slot: Slot): Promise<void> {
    await this.#enter("selectSlot");
    const offered = this.#slots(this.#store(conn.storeId), slot.modality);
    if (!offered.some((s) => s.id === slot.id)) {
      throw new RetailerError(this.id, "unknown_slot", `Slot ${slot.id} is not offered`);
    }
    this.#selectedSlots.set(conn.connectionId, slot);
  }

  /** Places an order for the cart at the connection's store. Needs a non-empty cart and a slot. */
  async checkout(conn: ConnectionHandle, _policy: unknown): Promise<{ orderRef: string }> {
    await this.#enter("checkout");
    const cart = this.#cart(conn);
    if (cart.size === 0) throw new RetailerError(this.id, "empty_cart", "The cart is empty");
    const slot = this.#selectedSlots.get(conn.connectionId);
    if (!slot) throw new RetailerError(this.id, "no_slot", "Select a slot first");
    const store = this.#store(conn.storeId);
    let total = slot.feeUsd ?? 0;
    for (const [productId, line] of cart) {
      const fixture = this.#byId.get(productId);
      if (!fixture) continue;
      const p = this.#product(fixture, store);
      total += (p.promoPrice ?? p.price ?? 0) * line.quantity;
    }
    const orders = this.#orders.get(conn.connectionId) ?? [];
    const order: Order = {
      id: `MOCK-ORDER-${orders.length + 1}`,
      placedAt: new Date(this.#now()).toISOString(),
      totalUsd: cents(total),
      status: "placed",
    };
    orders.push(order);
    this.#orders.set(conn.connectionId, orders);
    cart.clear();
    this.#selectedSlots.delete(conn.connectionId);
    return { orderRef: order.id };
  }

  async getOrders(conn: ConnectionHandle): Promise<Order[]> {
    await this.#enter("getOrders");
    return [...(this.#orders.get(conn.connectionId) ?? [])];
  }

  async handoffUrl(conn: ConnectionHandle): Promise<string> {
    await this.#enter("handoffUrl");
    return `https://mock-retailer.test/checkout?connection=${encodeURIComponent(conn.connectionId)}`;
  }
}
