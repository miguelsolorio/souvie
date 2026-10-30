import { describe, expect, it, vi } from "vitest";
import { MOCK_CAPABILITIES } from "../capabilities.ts";
import {
  RetailerAuthError,
  RetailerNotSupportedError,
  RetailerQuotaError,
  RetailerRequestError,
} from "../errors.ts";
import { isDisplayUnchanged, rememberReturned } from "../kroger/terms.ts";
import { pickCandidate, toCartItemDelta } from "../refs.ts";
import type { ConnectionHandle, Store } from "../types.ts";
import { MOCK_PRODUCTS, MOCK_STORES, MockRetailer } from "./MockRetailer.ts";

const T0 = Date.parse("2026-10-30T19:00:00Z");
const NOW = () => T0;

async function connected(mock: MockRetailer): Promise<ConnectionHandle> {
  const { handle } = await mock.connect({
    householdId: "h1",
    userId: "u1",
    redirectUri: "souvie://oauth/kroger",
  });
  if (!handle) throw new Error("mock did not connect");
  return handle;
}

async function firstStore(mock: MockRetailer): Promise<Store> {
  const [store] = await mock.findStores("98019");
  if (!store) throw new Error("no mock store");
  return store;
}

describe("fixtures", () => {
  it("has at least 200 products across produce, dairy, meat, pantry, and frozen", () => {
    expect(MOCK_PRODUCTS.length).toBeGreaterThanOrEqual(200);
    const byCategory = new Map<string, number>();
    for (const p of MOCK_PRODUCTS)
      byCategory.set(p.category, (byCategory.get(p.category) ?? 0) + 1);
    expect([...byCategory.keys()].sort()).toEqual(["dairy", "frozen", "meat", "pantry", "produce"]);
    for (const count of byCategory.values()) expect(count).toBeGreaterThanOrEqual(30);
  });

  it("uses unique ids and 13-digit UPCs", () => {
    expect(new Set(MOCK_PRODUCTS.map((p) => p.id)).size).toBe(MOCK_PRODUCTS.length);
    for (const p of MOCK_PRODUCTS) expect(p.upc).toMatch(/^\d{13}$/);
    expect(MOCK_STORES.length).toBeGreaterThanOrEqual(4);
  });
});

describe("MockRetailer", () => {
  it("claims every capability over its API", () => {
    const mock = new MockRetailer();
    expect(mock.capabilities).toEqual(MOCK_CAPABILITIES);
    expect(mock.id).toBe("kroger");
    expect(new MockRetailer({ id: "safeway" }).id).toBe("safeway");
  });

  it("returns deterministic search results for a seed", async () => {
    const a = new MockRetailer({ seed: 7, now: NOW });
    const b = new MockRetailer({ seed: 7, now: NOW });
    const store = await firstStore(a);
    const first = await a.searchProducts("chicken thighs", store);
    const again = await a.searchProducts("chicken thighs", store);
    const other = await b.searchProducts("chicken thighs", store);

    expect(first.length).toBeGreaterThan(0);
    expect(again).toEqual(first);
    expect(other).toEqual(first);
    for (const p of first) expect(p.name.toLowerCase()).toContain("chicken thigh");

    // Another seed: the same matches, with their own per-store prices.
    const reseeded = await new MockRetailer({ seed: 8, now: NOW }).searchProducts(
      "chicken thighs",
      store,
    );
    expect(reseeded.map((p) => p.id).sort()).toEqual(first.map((p) => p.id).sort());
    expect(reseeded.map((p) => p.price)).not.toEqual(first.map((p) => p.price));
  });

  it("varies prices by store, deterministically", async () => {
    const mock = new MockRetailer({ now: NOW });
    const [s1, s2] = await mock.findStores("98019");
    if (!s1 || !s2) throw new Error("need two stores");
    const here = await mock.getProducts(["0099030000002"], s1);
    const there = await mock.getProducts(["0099030000002"], s2);
    expect(here[0]?.id).toBe("0099030000002");
    expect(here[0]?.price).not.toBe(there[0]?.price);
    expect(await mock.getProducts(["0099030000002"], s1)).toEqual(here);
  });

  it("honors limit and brand, and returns nothing for an empty query", async () => {
    const mock = new MockRetailer({ now: NOW });
    const store = await firstStore(mock);
    expect(await mock.searchProducts("milk", store, { limit: 2 })).toHaveLength(2);
    const branded = await mock.searchProducts("cheese", store, { brand: "Northfork Creamery" });
    expect(branded.length).toBeGreaterThan(0);
    for (const p of branded) expect(p.brand).toBe("Northfork Creamery");
    expect(await mock.searchProducts("   ", store)).toEqual([]);
  });

  it("returns frozen products the terms guard can check once the app records them", async () => {
    const mock = new MockRetailer({ now: NOW });
    const [p] = await mock.searchProducts("eggs", await firstStore(mock));
    if (!p) throw new Error("no eggs");
    expect(Object.isFrozen(p)).toBe(true);
    expect(p.mayContain).toEqual([]);
    expect(p.cacheUntil).toBe(new Date(T0 + 300_000).toISOString());
    // The mock records nothing itself, like the Kroger adapter.
    expect(isDisplayUnchanged(p, {}, { now: T0 })).toBe(false);
    const returned = rememberReturned(p, { now: T0 });
    expect(isDisplayUnchanged(p, {}, { now: T0 })).toBe(true);
    expect(isDisplayUnchanged({ ...p, name: "EGGS" }, {}, { now: T0 })).toBe(false);
    returned.release();
  });

  it("reflects addToCart quantities in getCart", async () => {
    const mock = new MockRetailer({ now: NOW });
    const conn = await connected(mock);
    const store = await firstStore(mock);
    const candidates = await mock.searchProducts("whole milk", store);
    const milk = pickCandidate(store, candidates, 0);
    const eggs = pickCandidate(store, await mock.searchProducts("large eggs", store), 0);

    const result = await mock.addToCart(conn, [
      toCartItemDelta(milk, 2),
      toCartItemDelta(eggs, 1, "DELIVERY"),
    ]);
    expect(result.accepted).toHaveLength(2);
    expect(result.rejected).toEqual([]);
    expect((await mock.getCart(conn)).items).toEqual([
      { productId: milk.productId, quantity: 2, modality: "PICKUP" },
      { productId: eggs.productId, quantity: 1, modality: "DELIVERY" },
    ]);

    await mock.addToCart(conn, [toCartItemDelta(milk, -1), toCartItemDelta(eggs, -1)]);
    const cart = await mock.getCart(conn);
    expect(cart.items).toEqual([{ productId: milk.productId, quantity: 1, modality: "PICKUP" }]);
    expect(cart.fetchedAt).toBe(new Date(T0).toISOString());

    await mock.removeFromCart(conn, [milk.productId]);
    expect((await mock.getCart(conn)).items).toEqual([]);
  });

  it("rejects unknown products, a UPC that does not match, and zero deltas", async () => {
    const mock = new MockRetailer({ now: NOW });
    const conn = await connected(mock);
    const result = await mock.addToCart(conn, [
      { productId: "0000000000000", upc: null, quantityDelta: 1 },
      { productId: "0099030000002", upc: "0099030000003", quantityDelta: 1 },
      { productId: "0099030000002", upc: null, quantityDelta: 0 },
    ]);
    expect(result.accepted).toEqual([]);
    expect(result.rejected.map((r) => r.reason)).toEqual([
      "unknown product",
      "unknown product",
      "quantityDelta must be a non-zero integer",
    ]);
  });

  it("throws the configured typed error for a failure mode", async () => {
    const mock = new MockRetailer({
      now: NOW,
      failures: { searchProducts: "quota", addToCart: "auth", getSlots: "not_supported" },
    });
    const store = await firstStore(mock);
    const conn = await connected(mock);
    const quota = await mock.searchProducts("milk", store).catch((e) => e);
    expect(quota).toBeInstanceOf(RetailerQuotaError);
    expect(quota).toMatchObject({
      endpoint: "searchProducts",
      resetsAt: "2026-10-31T00:00:00.000Z",
    });
    await expect(mock.addToCart(conn, [])).rejects.toBeInstanceOf(RetailerAuthError);
    await expect(mock.getSlots(conn, store, "PICKUP")).rejects.toBeInstanceOf(
      RetailerNotSupportedError,
    );

    mock.setFailure("getProducts", "network");
    await expect(mock.getProducts(["x"], store)).rejects.toBeInstanceOf(RetailerRequestError);
    mock.setFailure("searchProducts", null);
    await expect(mock.searchProducts("milk", store)).resolves.not.toHaveLength(0);
  });

  it("fails at a seeded rate, the same way every run", async () => {
    const run = async () => {
      const mock = new MockRetailer({
        seed: 3,
        now: NOW,
        failureRate: { rate: 0.5, failure: "network", operations: ["getProducts"] },
      });
      const store = await firstStore(mock);
      const outcomes: boolean[] = [];
      for (let i = 0; i < 20; i++) {
        outcomes.push(
          await mock.getProducts(["0099010000001"], store).then(
            () => true,
            () => false,
          ),
        );
      }
      return outcomes;
    };
    const first = await run();
    expect(await run()).toEqual(first);
    expect(first).toContain(true);
    expect(first).toContain(false);
  });

  it("waits the configured latency before each operation", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const mock = new MockRetailer({ now: NOW, sleep, latencyMs: 120 });
    await mock.findStores("98019");
    expect(sleep).toHaveBeenCalledWith(120);
    const ranged = new MockRetailer({ now: NOW, sleep, latencyMs: { min: 10, max: 20 } });
    await ranged.findStores("98019");
    const ms = sleep.mock.calls.at(-1)?.[0] ?? -1;
    expect(ms).toBeGreaterThanOrEqual(10);
    expect(ms).toBeLessThanOrEqual(20);
  });

  it("supports slots, checkout, and orders so WS09 can test Tier 3 paths", async () => {
    const mock = new MockRetailer({ now: NOW });
    const conn = await connected(mock);
    const store = await firstStore(mock);
    const slots = await mock.getSlots(conn, store, "DELIVERY");
    expect(slots).toHaveLength(6);
    await expect(mock.checkout(conn, {})).rejects.toMatchObject({ code: "empty_cart" });

    const milk = pickCandidate(store, await mock.searchProducts("whole milk", store), 0);
    await mock.addToCart(conn, [toCartItemDelta(milk, 1)]);
    await expect(mock.checkout(conn, {})).rejects.toMatchObject({ code: "no_slot" });
    await expect(
      mock.selectSlot(conn, { ...(slots[0] as (typeof slots)[0]), id: "nope" }),
    ).rejects.toMatchObject({ code: "unknown_slot" });
    await mock.selectSlot(conn, slots[0] as (typeof slots)[0]);
    const { orderRef } = await mock.checkout(conn, {});
    expect(orderRef).toBe("MOCK-ORDER-1");
    const [order] = await mock.getOrders(conn);
    expect(order?.totalUsd).toBeGreaterThan(9.95);
    expect((await mock.getCart(conn)).items).toEqual([]);
  });

  it("logs every call for replay assertions, and resets", async () => {
    const mock = new MockRetailer({ now: NOW });
    await mock.findStores("98019");
    await mock.handoffUrl(await connected(mock));
    expect(mock.calls.map((c) => c.operation)).toEqual(["findStores", "connect", "handoffUrl"]);
    mock.reset();
    expect(mock.calls).toEqual([]);
  });
});
