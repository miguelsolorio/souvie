import { describe, expect, it, vi } from "vitest";
import { RetailerAuthError } from "../errors.ts";
import type { ConnectionHandle } from "../types.ts";
import cartAdd from "./__fixtures__/cart-add.json";
import { replay, T0, TEST_CONFIG, to } from "./__fixtures__/replay.ts";
import tokenRefresh from "./__fixtures__/token-refresh.json";
import unauthorized from "./__fixtures__/unauthorized.json";
import type { RefreshTokenVault } from "./auth.ts";
import { normalizeUpc, prepareCartItems } from "./cart.ts";
import { KrogerAdapter } from "./KrogerAdapter.ts";

const CART = "/v1/cart/add";
const TOKEN = "/v1/connect/oauth2/token";

const CONN: ConnectionHandle = {
  connectionId: "c0000000-0000-4000-8000-0000000000c1",
  retailer: "kroger",
  storeId: "70500999",
  modality: "DELIVERY",
};

function vault() {
  return {
    saveConnection: vi.fn(async () => ({ connectionId: CONN.connectionId })),
    read: vi.fn(async () => "stored-refresh-token"),
    rotate: vi.fn(async () => {}),
    markNeedsReauth: vi.fn(async () => {}),
  } satisfies RefreshTokenVault;
}

function setup(cartResponses: Parameters<typeof replay>[0][number]["respond"]) {
  const v = vault();
  const http = replay([
    { method: "POST", path: TOKEN, respond: tokenRefresh },
    { method: "PUT", path: CART, respond: cartResponses },
  ]);
  const adapter = new KrogerAdapter({ ...TEST_CONFIG, fetch: http.fetch, vault: v, now: () => T0 });
  return { adapter, vault: v, ...http };
}

function bodyOf(req: { body: string | null } | undefined): unknown {
  return JSON.parse(req?.body ?? "null");
}

describe("addToCart", () => {
  it("sends PUT /v1/cart/add with 13-digit UPCs and the connection's modality", async () => {
    const { adapter, requests } = setup(cartAdd);
    const result = await adapter.addToCart(CONN, [
      { productId: "0009990001001", upc: "0009990001001", quantityDelta: 2 },
      // A 12-digit UPC-A is padded to Kroger's 13 digits.
      { productId: "0009990001002", upc: "009990001002", quantityDelta: 1 },
    ]);

    const [put] = to(requests, CART, "PUT");
    expect(to(requests, CART, "PUT")).toHaveLength(1);
    expect(put?.headers.get("content-type")).toBe("application/json");
    expect(put?.headers.get("authorization")).toBe("Bearer fixture-customer-access-token-2");
    expect(bodyOf(put)).toEqual({
      items: [
        { upc: "0009990001001", quantity: 2, modality: "DELIVERY" },
        { upc: "0009990001002", quantity: 1, modality: "DELIVERY" },
      ],
    });
    for (const item of (bodyOf(put) as { items: { upc: string }[] }).items) {
      expect(item.upc).toMatch(/^\d{13}$/);
    }
    expect(result.accepted).toHaveLength(2);
    expect(result.rejected).toEqual([]);
  });

  it("sends a quantityDelta of -1 as quantity: -1", async () => {
    const { adapter, requests } = setup(cartAdd);
    await adapter.addToCart(CONN, [
      { productId: "0009990001001", upc: "0009990001001", quantityDelta: -1 },
    ]);
    expect(bodyOf(to(requests, CART, "PUT")[0])).toEqual({
      items: [{ upc: "0009990001001", quantity: -1, modality: "DELIVERY" }],
    });
  });

  it("lets an item override the connection's modality", async () => {
    const { adapter, requests } = setup(cartAdd);
    await adapter.addToCart({ ...CONN, modality: undefined }, [
      { productId: "0009990001001", upc: null, quantityDelta: 1 },
      { productId: "0009990001002", upc: null, quantityDelta: 1, modality: "DELIVERY" },
    ]);
    expect(bodyOf(to(requests, CART, "PUT")[0])).toEqual({
      items: [
        { upc: "0009990001001", quantity: 1, modality: "PICKUP" },
        { upc: "0009990001002", quantity: 1, modality: "DELIVERY" },
      ],
    });
  });

  it("refreshes once on a 401 and retries once", async () => {
    const { adapter, vault: v, requests } = setup([unauthorized, cartAdd]);
    const result = await adapter.addToCart(CONN, [
      { productId: "0009990001001", upc: "0009990001001", quantityDelta: 1 },
    ]);
    expect(result.accepted).toHaveLength(1);
    expect(to(requests, CART, "PUT")).toHaveLength(2);
    // First refresh for the initial token, second after the 401.
    expect(to(requests, TOKEN, "POST")).toHaveLength(2);
    expect(v.rotate).toHaveBeenLastCalledWith(
      CONN.connectionId,
      "fixture-customer-refresh-token-2",
    );
    expect(v.markNeedsReauth).not.toHaveBeenCalled();
  });

  it("throws RetailerAuthError after the retry also gets a 401, and flags the connection", async () => {
    const { adapter, vault: v, requests } = setup(unauthorized);
    const err = await adapter
      .addToCart(CONN, [{ productId: "0009990001001", upc: "0009990001001", quantityDelta: 1 }])
      .catch((e) => e);
    expect(err).toBeInstanceOf(RetailerAuthError);
    expect(err).toMatchObject({ connectionId: CONN.connectionId, needsReauth: true });
    // One refresh and one retry, never a loop.
    expect(to(requests, CART, "PUT")).toHaveLength(2);
    expect(to(requests, TOKEN, "POST")).toHaveLength(2);
    expect(v.markNeedsReauth).toHaveBeenCalledWith(CONN.connectionId);
  });

  it("rejects invalid deltas without sending them", async () => {
    const { adapter, requests } = setup(cartAdd);
    const result = await adapter.addToCart(CONN, [
      { productId: "0009990001001", upc: "0009990001001", quantityDelta: 0 },
      { productId: "0009990001001", upc: "0009990001001", quantityDelta: 1.5 },
      { productId: "not-a-upc", upc: null, quantityDelta: 1 },
    ]);
    expect(result.accepted).toEqual([]);
    expect(result.rejected.map((r) => r.reason)).toEqual([
      "quantityDelta must be a non-zero integer",
      "quantityDelta must be a non-zero integer",
      "no 13-digit UPC for this product",
    ]);
    expect(requests).toHaveLength(0);
  });

  it("rejects a chunk Kroger refuses, with Kroger's reason", async () => {
    const { adapter } = setup({
      status: 400,
      headers: { "content-type": "application/json" },
      body: { errors: { code: "CART-2041", reason: "Invalid upc" } },
    });
    const result = await adapter.addToCart(CONN, [
      { productId: "0009990001001", upc: "0009990001001", quantityDelta: 1 },
    ]);
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([
      {
        item: { productId: "0009990001001", upc: "0009990001001", quantityDelta: 1 },
        reason: "Invalid upc",
      },
    ]);
  });

  it("refuses a connection that is not Kroger's", async () => {
    const { adapter } = setup(cartAdd);
    await expect(
      adapter.addToCart({ ...CONN, retailer: "instacart" }, [
        { productId: "1", upc: null, quantityDelta: 1 },
      ]),
    ).rejects.toThrow("Not a Kroger connection");
  });
});

describe("cart helpers", () => {
  it("normalizes UPCs to 13 digits and refuses anything else", () => {
    expect(normalizeUpc("0001111042850")).toBe("0001111042850");
    expect(normalizeUpc("001111042850")).toBe("0001111042850");
    expect(normalizeUpc("12345678")).toBe("0000012345678");
    expect(normalizeUpc("1234567")).toBeNull();
    expect(normalizeUpc("00011110428501")).toBeNull();
    expect(normalizeUpc("abc")).toBeNull();
    expect(normalizeUpc(null)).toBeNull();
  });

  it("falls back to the product id, which is the UPC for Kroger", () => {
    const { ready } = prepareCartItems(CONN, [
      { productId: "0009990001001", upc: null, quantityDelta: 3 },
    ]);
    expect(ready[0]?.line).toEqual({ upc: "0009990001001", quantity: 3, modality: "DELIVERY" });
  });

  it("has no cart read: getCart is absent, matching cartRead 'none'", () => {
    const adapter = new KrogerAdapter(TEST_CONFIG);
    expect(adapter.capabilities.cartRead).toBe("none");
    expect("getCart" in adapter).toBe(false);
  });
});
