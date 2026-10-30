import { describe, expect, it, vi } from "vitest";
import { RetailerQuotaError } from "../errors.ts";
import { clock, QFC_STORE, replay, T0, TEST_CONFIG, to } from "./__fixtures__/replay.ts";
import tokenClientCredentials from "./__fixtures__/token-client-credentials.json";
import { KrogerAdapter } from "./KrogerAdapter.ts";
import {
  createRpcQuotaStore,
  InMemoryQuotaStore,
  KROGER_DAILY_QUOTAS,
  QuotaGuard,
  utcDay,
} from "./quota.ts";

const TOKEN = { method: "POST", path: "/v1/connect/oauth2/token", respond: tokenClientCredentials };
const EMPTY = { status: 200, headers: { "content-type": "application/json" }, body: { data: [] } };

describe("Products quota", () => {
  it("throws RetailerQuotaError on the 9,501st call of the day without hitting the network", async () => {
    const c = clock();
    const store = new InMemoryQuotaStore();
    const { fetch, requests } = replay([TOKEN, { path: "/v1/products", respond: EMPTY }]);
    const adapter = new KrogerAdapter({ ...TEST_CONFIG, fetch, now: c.now, quotaStore: store });

    for (let i = 0; i < 9_500; i++) {
      await adapter.getProducts([`0009990${String(i).padStart(6, "0")}`], QFC_STORE);
    }
    expect(to(requests, "/v1/products")).toHaveLength(9_500);
    expect(store.counts.get(`kroger|products|${utcDay(new Date(T0))}`)).toBe(9_500);

    const before = to(requests, "/v1/products").length;
    const err = await adapter.searchProducts("milk", QFC_STORE).catch((e) => e);
    expect(err).toBeInstanceOf(RetailerQuotaError);
    expect(err).toMatchObject({
      endpoint: "products",
      used: 9_500,
      limit: 10_000,
      resetsAt: "2026-10-31T00:00:00.000Z",
    });
    expect(to(requests, "/v1/products").length).toBe(before);

    // A new UTC day starts a new budget.
    c.set(Date.parse("2026-10-31T00:00:01Z"));
    await expect(adapter.searchProducts("milk", QFC_STORE)).resolves.toEqual([]);
    expect(to(requests, "/v1/products").length).toBe(before + 1);
  });

  it("budgets each endpoint separately", async () => {
    const store = new InMemoryQuotaStore();
    const guard = new QuotaGuard({ store, now: () => new Date(T0) });
    await store.raiseTo("kroger", "products", utcDay(new Date(T0)), 9_500);
    await expect(guard.reserve("products")).rejects.toBeInstanceOf(RetailerQuotaError);
    await expect(guard.reserve("cart")).resolves.toBeUndefined();
    expect(guard.ceiling("cart")).toBe(4_750);
    expect(guard.ceiling("locations")).toBe(1_520);
  });
});

describe("QuotaGuard.observe", () => {
  it("raises our count to what Kroger's headers say was used", async () => {
    const store = new InMemoryQuotaStore();
    const guard = new QuotaGuard({ store, now: () => new Date(T0) });
    await guard.observe(
      "products",
      200,
      new Headers({ "x-ratelimit-limit-day": "10000", "x-ratelimit-remaining-day": "450" }),
    );
    expect(store.counts.get(`kroger|products|${utcDay(new Date(T0))}`)).toBe(9_550);
    await expect(guard.reserve("products")).rejects.toBeInstanceOf(RetailerQuotaError);
  });

  it("adopts a lower daily limit from the headers, never a higher one", async () => {
    const guard = new QuotaGuard({ store: new InMemoryQuotaStore(), now: () => new Date(T0) });
    await guard.observe(
      "locations",
      200,
      new Headers({ "x-ratelimit-limit-day": "5000", "x-ratelimit-remaining-day": "4999" }),
    );
    expect(guard.limit("locations")).toBe(KROGER_DAILY_QUOTAS.locations);
    await guard.observe(
      "cart",
      200,
      new Headers({ "x-ratelimit-limit-day": "1000", "x-ratelimit-remaining-day": "999" }),
    );
    expect(guard.limit("cart")).toBe(1_000);
    expect(guard.ceiling("cart")).toBe(950);
  });

  it("treats a 429 as the day's budget spent, so later calls stop before the network", async () => {
    const store = new InMemoryQuotaStore();
    const { fetch, requests } = replay([
      TOKEN,
      {
        path: "/v1/products",
        respond: { status: 429, headers: {}, body: { message: "Too Many" } },
      },
    ]);
    const adapter = new KrogerAdapter({ ...TEST_CONFIG, fetch, now: () => T0, quotaStore: store });
    await expect(adapter.searchProducts("milk", QFC_STORE)).rejects.toBeInstanceOf(
      RetailerQuotaError,
    );
    const calls = to(requests, "/v1/products").length;
    await expect(adapter.searchProducts("eggs", QFC_STORE)).rejects.toBeInstanceOf(
      RetailerQuotaError,
    );
    expect(to(requests, "/v1/products").length).toBe(calls);
  });
});

describe("createRpcQuotaStore", () => {
  it("calls retailer_quota_consume and retailer_quota_raise", async () => {
    const rpc = vi.fn(async (fn: string) =>
      fn === "retailer_quota_consume"
        ? { data: [{ allowed: false, used: 9_500 }], error: null }
        : { data: null, error: null },
    );
    const store = createRpcQuotaStore(rpc);
    await expect(store.consume("kroger", "products", "2026-10-30", 9_500, 1)).resolves.toEqual({
      allowed: false,
      used: 9_500,
    });
    expect(rpc).toHaveBeenCalledWith("retailer_quota_consume", {
      p_retailer: "kroger",
      p_endpoint: "products",
      p_day: "2026-10-30",
      p_ceiling: 9_500,
      p_amount: 1,
    });
    await store.raiseTo("kroger", "cart", "2026-10-30", 12);
    expect(rpc).toHaveBeenLastCalledWith("retailer_quota_raise", {
      p_retailer: "kroger",
      p_endpoint: "cart",
      p_day: "2026-10-30",
      p_count: 12,
    });
  });

  it("throws when the database call fails, so a broken counter never means unlimited calls", async () => {
    const store = createRpcQuotaStore(async () => ({ data: null, error: { message: "boom" } }));
    await expect(store.consume("kroger", "products", "2026-10-30", 1, 1)).rejects.toThrow("boom");
  });
});
