import { describe, expect, it } from "vitest";
import locations98019 from "./__fixtures__/locations-98019.json";
import { replay, T0, TEST_CONFIG, to } from "./__fixtures__/replay.ts";
import tokenClientCredentials from "./__fixtures__/token-client-credentials.json";
import { bannerForChain } from "./auth.ts";
import { KROGER_CHECKOUT_URL, KrogerAdapter } from "./KrogerAdapter.ts";

const TOKEN = { method: "POST", path: "/v1/connect/oauth2/token", respond: tokenClientCredentials };

function adapterWith(routes: Parameters<typeof replay>[0]) {
  const http = replay([TOKEN, ...routes]);
  return {
    adapter: new KrogerAdapter({ ...TEST_CONFIG, fetch: http.fetch, now: () => T0 }),
    ...http,
  };
}

describe("findStores", () => {
  it("asks for stores near the ZIP and keeps only QFC and Fred Meyer, as returned", async () => {
    const { adapter, requests } = adapterWith([{ path: "/v1/locations", respond: locations98019 }]);
    const stores = await adapter.findStores("98019");

    const [req] = to(requests, "/v1/locations");
    expect(req?.url.searchParams.get("filter.zipCode.near")).toBe("98019");
    expect(req?.url.searchParams.get("filter.radiusInMiles")).toBe("10");
    expect(req?.url.searchParams.get("filter.limit")).toBe("50");

    expect(stores).toEqual([
      {
        id: "70500999",
        retailer: "kroger",
        chain: "QFC",
        name: "Quality Food Center - Fixture Ridge",
        address: "100 Fixture Ridge Rd NE, Duvall, WA",
        zip: "98019",
        lat: 47.7401,
        lng: -121.9862,
      },
      {
        id: "70100999",
        retailer: "kroger",
        chain: "FRED",
        name: "Fred Meyer - Fixture Lake",
        address: "200 Fixture Lake Way, Suite B, Monroe, WA",
        zip: "98272",
        lat: 47.8611,
        lng: -121.9903,
      },
    ]);
    expect(stores.map((s) => bannerForChain(s.chain))).toEqual(["qfc", "fredmeyer"]);
  });

  it("clamps the radius and skips the call for something that is not a ZIP", async () => {
    const { adapter, requests } = adapterWith([{ path: "/v1/locations", respond: locations98019 }]);
    await adapter.findStores("98019", { radiusMiles: 500 });
    expect(to(requests, "/v1/locations")[0]?.url.searchParams.get("filter.radiusInMiles")).toBe(
      "100",
    );
    await expect(adapter.findStores("980")).resolves.toEqual([]);
    await expect(adapter.findStores("98019-1234")).resolves.toEqual([]);
    expect(to(requests, "/v1/locations")).toHaveLength(1);
  });
});

describe("getStore", () => {
  it("reads one location by id and returns null for a malformed id without a call", async () => {
    const one = {
      status: 200,
      headers: { "content-type": "application/json" },
      body: { data: locations98019.body.data[0] },
    };
    const { adapter, requests } = adapterWith([{ path: "/v1/locations/70500999", respond: one }]);
    await expect(adapter.getStore("70500999")).resolves.toMatchObject({ id: "70500999" });
    await expect(adapter.getStore("../../x")).resolves.toBeNull();
    expect(requests.filter((r) => r.url.pathname.startsWith("/v1/locations"))).toHaveLength(1);
  });
});

describe("hand-off", () => {
  it("sends the customer to Kroger checkout", async () => {
    const adapter = new KrogerAdapter(TEST_CONFIG);
    await expect(adapter.handoffUrl()).resolves.toBe(KROGER_CHECKOUT_URL);
    expect(KROGER_CHECKOUT_URL).toBe("https://www.kroger.com/checkout");
  });
});
