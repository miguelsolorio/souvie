import { describe, expect, it } from "vitest";
import productsChickenThighs from "./__fixtures__/products-chicken-thighs.json";
import { clock, QFC_STORE, replay, T0, TEST_CONFIG, to } from "./__fixtures__/replay.ts";
import tokenClientCredentials from "./__fixtures__/token-client-credentials.json";
import { cacheDecision, ResponseCache } from "./cache.ts";
import { KrogerAdapter } from "./KrogerAdapter.ts";
import { InMemoryQuotaStore, utcDay } from "./quota.ts";

const TOKEN = { method: "POST", path: "/v1/connect/oauth2/token", respond: tokenClientCredentials };
const h = (init: Record<string, string>) => new Headers(init);

describe("cacheDecision", () => {
  it("uses max-age, minus Age", () => {
    expect(cacheDecision(h({ "cache-control": "public, max-age=60" }), T0)).toEqual({
      expiresAt: T0 + 60_000,
      storable: true,
    });
    expect(cacheDecision(h({ "cache-control": "max-age=60", age: "45" }), T0).expiresAt).toBe(
      T0 + 15_000,
    );
    expect(cacheDecision(h({ "cache-control": "max-age=60", age: "60" }), T0).storable).toBe(false);
  });

  it("prefers max-age over Expires, and reads Expires against the response Date", () => {
    expect(
      cacheDecision(
        h({ "cache-control": "max-age=10", expires: "Fri, 30 Oct 2026 23:00:00 GMT" }),
        T0,
      ).expiresAt,
    ).toBe(T0 + 10_000);
    const decision = cacheDecision(
      h({ date: "Fri, 30 Oct 2026 19:00:00 GMT", expires: "Fri, 30 Oct 2026 19:02:00 GMT" }),
      T0,
    );
    expect(decision).toEqual({ expiresAt: T0 + 120_000, storable: true });
  });

  it("never stores no-store, no-cache, an invalid Expires, or a response with no cache headers", () => {
    const cases: Record<string, string>[] = [
      { "cache-control": "no-store, max-age=600" },
      { "cache-control": "no-cache" },
      { expires: "0" },
      { expires: "Fri, 30 Oct 2026 19:00:00 GMT", date: "Fri, 30 Oct 2026 19:00:00 GMT" },
      {},
    ];
    for (const headers of cases) {
      expect(cacheDecision(h(headers), T0)).toEqual({ expiresAt: T0, storable: false });
    }
  });
});

describe("ResponseCache", () => {
  it("drops entries at expiry and evicts the least recently used past its bound", () => {
    const c = clock();
    const cache = new ResponseCache<string>({ now: c.now, maxEntries: 2 });
    cache.set("a", "A", T0 + 1000);
    cache.set("b", "B", T0 + 1000);
    cache.get("a");
    cache.set("c", "C", T0 + 1000);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")?.value).toBe("A");
    c.advance(1000);
    expect(cache.get("a")).toBeUndefined();
    cache.set("stale", "S", T0);
    expect(cache.size).toBe(1);
  });
});

describe("search caching", () => {
  it("answers a second identical search inside max-age from memory, and goes back to Kroger one second after expiry", async () => {
    const c = clock();
    const quota = new InMemoryQuotaStore();
    const { fetch, requests } = replay([
      TOKEN,
      { path: "/v1/products", respond: productsChickenThighs },
    ]);
    const adapter = new KrogerAdapter({ ...TEST_CONFIG, fetch, now: c.now, quotaStore: quota });

    const first = await adapter.searchProducts("chicken thighs", QFC_STORE);
    c.advance(3_599_000);
    const second = await adapter.searchProducts("chicken thighs", QFC_STORE);
    expect(to(requests, "/v1/products")).toHaveLength(1);
    expect(second).toEqual(first);
    // A cache hit spends no quota.
    expect(quota.counts.get(`kroger|products|${utcDay(new Date(T0))}`)).toBe(1);

    c.set(T0 + 3_600_000 + 1_000);
    const third = await adapter.searchProducts("chicken thighs", QFC_STORE);
    expect(to(requests, "/v1/products")).toHaveLength(2);
    expect(third[0]?.cacheUntil).toBe(new Date(T0 + 3_601_000 + 3_600_000).toISOString());
  });

  it("does not cache what Kroger sends today: no Cache-Control, no Expires", async () => {
    const noHeaders = { ...productsChickenThighs, headers: { "content-type": "application/json" } };
    const { fetch, requests } = replay([TOKEN, { path: "/v1/products", respond: noHeaders }]);
    const adapter = new KrogerAdapter({ ...TEST_CONFIG, fetch, now: () => T0 });
    const [product] = await adapter.searchProducts("chicken thighs", QFC_STORE);
    await adapter.searchProducts("chicken thighs", QFC_STORE);
    expect(to(requests, "/v1/products")).toHaveLength(2);
    // Stale on arrival: callers know the price must be fetched again next time.
    expect(product?.cacheUntil).toBe(new Date(T0).toISOString());
  });

  it("keys the cache on the full request, so another store or term is a miss", async () => {
    const { fetch, requests } = replay([
      TOKEN,
      { path: "/v1/products", respond: productsChickenThighs },
    ]);
    const adapter = new KrogerAdapter({ ...TEST_CONFIG, fetch, now: () => T0 });
    await adapter.searchProducts("chicken thighs", QFC_STORE);
    await adapter.searchProducts("chicken thighs", { ...QFC_STORE, id: "70100999" });
    await adapter.searchProducts("chicken breast", QFC_STORE);
    expect(to(requests, "/v1/products")).toHaveLength(3);
  });
});
