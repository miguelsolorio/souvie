import { describe, expect, it } from "vitest";
import { RetailerRequestError } from "../errors.ts";
import productsChickenThighs from "./__fixtures__/products-chicken-thighs.json";
import productsTermTooShort from "./__fixtures__/products-term-too-short.json";
import { clock, QFC_STORE, replay, T0, TEST_CONFIG, to } from "./__fixtures__/replay.ts";
import tokenClientCredentials from "./__fixtures__/token-client-credentials.json";
import { KrogerAdapter } from "./KrogerAdapter.ts";
import type { KrogerProduct } from "./mappers.ts";
import { MAX_IDS_PER_REQUEST, normalizeTerm } from "./products.ts";

const TOKEN = { method: "POST", path: "/v1/connect/oauth2/token", respond: tokenClientCredentials };

function adapterWith(routes: Parameters<typeof replay>[0], now = () => T0) {
  const http = replay([TOKEN, ...routes]);
  return { adapter: new KrogerAdapter({ ...TEST_CONFIG, fetch: http.fetch, now }), ...http };
}

describe("searchProducts", () => {
  it("sends filter.term, filter.locationId, and filter.limit=50", async () => {
    const { adapter, requests } = adapterWith([
      { path: "/v1/products", respond: productsChickenThighs },
    ]);
    await adapter.searchProducts("chicken thighs", QFC_STORE);

    const [req] = to(requests, "/v1/products");
    expect(req?.url.searchParams.get("filter.term")).toBe("chicken thighs");
    expect(req?.url.searchParams.get("filter.locationId")).toBe("70500999");
    expect(req?.url.searchParams.get("filter.limit")).toBe("50");
    expect(req?.headers.get("authorization")).toBe("Bearer fixture-app-access-token");
  });

  it("maps a recorded response to Product with prices, stock, fulfillment, allergens, and cacheUntil", async () => {
    const { adapter } = adapterWith([{ path: "/v1/products", respond: productsChickenThighs }]);
    const [thighs, boneIn, bites, organic] = await adapter.searchProducts(
      "chicken thighs",
      QFC_STORE,
    );

    // cacheUntil comes from the recorded Cache-Control: max-age=3600.
    const cacheUntil = new Date(T0 + 3600 * 1000).toISOString();
    expect(thighs).toEqual({
      id: "0009990001001",
      upc: "0009990001001",
      name: "Fixture Farms® Boneless Skinless Chicken Thighs Family Pack",
      brand: "Fixture Farms",
      size: "per lb",
      price: 5.99,
      promoPrice: 4.49,
      soldBy: "WEIGHT",
      stockLevel: "HIGH",
      fulfillment: { instore: true, curbside: true, delivery: true, shiptohome: false },
      // "Free from" milk is not an allergen the product contains.
      allergens: [],
      imageUrl: "https://images.fixture.test/large/front/0009990001001",
      cacheUntil,
    });

    // promo 0 means no promotion; no featured image falls back to the front one.
    expect(boneIn).toMatchObject({
      price: 11.99,
      promoPrice: null,
      soldBy: "UNIT",
      stockLevel: "LOW",
      fulfillment: { instore: true, curbside: true, delivery: false, shiptohome: false },
      imageUrl: "https://images.fixture.test/medium/front/0009990001002",
      cacheUntil,
    });

    // "Contains" and "May Contain" both count; no images means no image.
    expect(bites).toMatchObject({
      price: 8.49,
      promoPrice: null,
      stockLevel: "TEMPORARILY_OUT_OF_STOCK",
      allergens: [
        "Wheat and its derivatives",
        "Soybean and its Derivatives",
        "Sesame Seeds and its derivatives",
      ],
      imageUrl: null,
    });

    // No price block and no inventory: null price and UNKNOWN stock. The name keeps its
    // trailing space, exactly as returned.
    expect(organic).toMatchObject({
      name: "Puget Organics Organic Chicken Thighs ",
      price: null,
      promoPrice: null,
      soldBy: null,
      stockLevel: "UNKNOWN",
      allergens: [],
      imageUrl: "https://images.fixture.test/small/left/0009990001004",
    });
  });

  it("returns frozen products so nothing downstream can edit a display field", async () => {
    const { adapter } = adapterWith([{ path: "/v1/products", respond: productsChickenThighs }]);
    const [first] = await adapter.searchProducts("chicken thighs", QFC_STORE);
    expect(Object.isFrozen(first)).toBe(true);
    expect(() => {
      (first as { name: string }).name = "edited";
    }).toThrow(TypeError);
  });

  it("passes brand and a smaller limit through, and caps the limit at 50", async () => {
    const { adapter, requests } = adapterWith([
      { path: "/v1/products", respond: productsChickenThighs },
    ]);
    await adapter.searchProducts("milk", QFC_STORE, { limit: 5, brand: "Fixture Farms" });
    await adapter.searchProducts("eggs", QFC_STORE, { limit: 500 });
    const [first, second] = to(requests, "/v1/products");
    expect(first?.url.searchParams.get("filter.limit")).toBe("5");
    expect(first?.url.searchParams.get("filter.brand")).toBe("Fixture Farms");
    expect(second?.url.searchParams.get("filter.limit")).toBe("50");
  });

  it("does not call Kroger for a term under 3 characters, and trims long terms to 8 words", async () => {
    const { adapter, requests } = adapterWith([
      { path: "/v1/products", respond: productsChickenThighs },
    ]);
    await expect(adapter.searchProducts("mi", QFC_STORE)).resolves.toEqual([]);
    expect(requests).toHaveLength(0);
    expect(normalizeTerm("  boneless   skinless chicken thighs  ")).toBe(
      "boneless skinless chicken thighs",
    );
    expect(normalizeTerm("one two three four five six seven eight nine ten")).toBe(
      "one two three four five six seven eight",
    );
    expect(normalizeTerm("x".repeat(200))?.length).toBe(127);
  });

  it("raises Kroger's own error code on a 400", async () => {
    const { adapter } = adapterWith([{ path: "/v1/products", respond: productsTermTooShort }]);
    const err = await adapter.searchProducts("abc", QFC_STORE).catch((e) => e);
    expect(err).toBeInstanceOf(RetailerRequestError);
    expect(err).toMatchObject({ status: 400, retailerCode: "PRODUCT-2017" });
  });
});

describe("getProducts", () => {
  function productsFor(ids: string[]) {
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: {
        data: ids.map(
          (id): KrogerProduct => ({
            productId: id,
            upc: id,
            description: `Fixture product ${id}`,
            items: [{ size: "1 ct", price: { regular: 1.99 } }],
          }),
        ),
      },
    };
  }

  it("issues two requests of 50 and 10 for 60 ids", async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `00099900${String(i).padStart(5, "0")}`);
    const { adapter, requests } = adapterWith([
      {
        path: "/v1/products",
        respond: (req) =>
          productsFor((req.url.searchParams.get("filter.productId") ?? "").split(",")),
      },
    ]);

    const products = await adapter.getProducts(ids, QFC_STORE);

    const calls = to(requests, "/v1/products");
    expect(calls).toHaveLength(2);
    const batches = calls.map((c) => (c.url.searchParams.get("filter.productId") ?? "").split(","));
    expect(batches.map((b) => b.length)).toEqual([MAX_IDS_PER_REQUEST, 10]);
    expect(batches.flat()).toEqual(ids);
    for (const call of calls) {
      expect(call.url.searchParams.get("filter.locationId")).toBe(QFC_STORE.id);
      expect(call.url.searchParams.has("filter.term")).toBe(false);
    }
    expect(products.map((p) => p.id)).toEqual(ids);
  });

  it("sends duplicate ids once and leaves out ids Kroger did not return", async () => {
    const { adapter, requests } = adapterWith([
      { path: "/v1/products", respond: productsFor(["0009990000002"]) },
    ]);
    const products = await adapter.getProducts(
      ["0009990000001", "0009990000002", "0009990000001"],
      QFC_STORE,
    );
    expect(to(requests, "/v1/products")[0]?.url.searchParams.get("filter.productId")).toBe(
      "0009990000001,0009990000002",
    );
    expect(products.map((p) => p.id)).toEqual(["0009990000002"]);
  });

  it("makes no call for an empty list", async () => {
    const { adapter, requests } = adapterWith([]);
    await expect(adapter.getProducts([], QFC_STORE)).resolves.toEqual([]);
    expect(requests).toHaveLength(0);
  });
});

describe("app token reuse across catalog calls", () => {
  it("renews the app token after a 401 and retries once", async () => {
    const c = clock();
    const { adapter, requests } = adapterWith(
      [
        {
          path: "/v1/products",
          respond: [
            { status: 401, headers: {}, body: { message: "Unauthorized" } },
            productsChickenThighs,
          ],
        },
      ],
      c.now,
    );
    const products = await adapter.searchProducts("chicken thighs", QFC_STORE);
    expect(products).toHaveLength(4);
    expect(to(requests, "/v1/connect/oauth2/token", "POST")).toHaveLength(2);
    expect(to(requests, "/v1/products")).toHaveLength(2);
  });
});
