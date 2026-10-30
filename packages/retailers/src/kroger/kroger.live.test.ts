// Live smoke test against api.kroger.com (WS07 criterion 12). Skipped unless KROGER_LIVE_TEST=1,
// so CI never runs it. Run it locally:
//
//   KROGER_LIVE_TEST=1 pnpm test --filter retailers -- kroger.live
//
// Reads KROGER_CLIENT_ID and KROGER_CLIENT_SECRET from the environment or the repo's .env.local.
// The cart step also needs the developer's own refresh token: run
// `pnpm --filter @mp/retailers kroger:login` once, which saves it to .env.kroger.local
// (gitignored). The certification host has no customer accounts, so this runs in production.
// It adds one real item to the developer's own Kroger cart. Remove it at kroger.com afterwards.
import { describe, expect, it } from "vitest";
import type { Product, Store } from "../types.ts";
import { KrogerAdapter } from "./KrogerAdapter.ts";
import { fileVault, liveEnv } from "./live-env.ts";

const LIVE = process.env.KROGER_LIVE_TEST === "1";
const clientId = LIVE ? liveEnv("KROGER_CLIENT_ID") : undefined;
const clientSecret = LIVE ? liveEnv("KROGER_CLIENT_SECRET") : undefined;
const redirectUri = (LIVE && liveEnv("KROGER_REDIRECT_URI")) || "souvie://oauth/kroger";
const hasCustomerToken = LIVE && Boolean(liveEnv("KROGER_LIVE_REFRESH_TOKEN"));

const statuses: { method: string; path: string; status: number }[] = [];
const recordingFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
  statuses.push({ method: init?.method ?? "GET", path: url.pathname, status: res.status });
  return res;
};

describe.skipIf(!LIVE)("Kroger live smoke (KROGER_LIVE_TEST=1)", () => {
  let adapter: KrogerAdapter;
  let store: Store | undefined;
  let milk: Product[] = [];

  it("has app credentials", () => {
    expect(clientId, "KROGER_CLIENT_ID").toBeTruthy();
    expect(clientSecret, "KROGER_CLIENT_SECRET").toBeTruthy();
    adapter = new KrogerAdapter({
      clientId: clientId ?? "",
      clientSecret: clientSecret ?? "",
      redirectUri,
      vault: fileVault(),
      fetch: recordingFetch,
    });
  });

  it("finds at least one store for ZIP 98019", async () => {
    const stores = await adapter.findStores("98019");
    expect(stores.length).toBeGreaterThan(0);
    store = stores[0];
    console.info(`live: ${stores.length} stores near 98019; using ${store?.chain} ${store?.id}`);
  });

  it('searches "milk" at that store with live prices', async () => {
    if (!store) throw new Error("no store from the previous step");
    milk = await adapter.searchProducts("milk", store);
    expect(milk.length).toBeGreaterThan(0);
    expect(milk.some((p) => p.price !== null)).toBe(true);
    console.info(`live: ${milk.length} results for "milk"`);
  });

  it("looks the first results up again by id in one batch call", async () => {
    if (!store) throw new Error("no store from the previous step");
    const ids = milk.slice(0, 12).map((p) => p.id);
    const before = statuses.filter((s) => s.path === "/v1/products").length;
    const again = await adapter.getProducts(ids, store);
    expect(again.map((p) => p.id)).toEqual(ids);
    expect(statuses.filter((s) => s.path === "/v1/products").length).toBe(before + 1);
  });

  it.skipIf(!hasCustomerToken)(
    "adds one item to the developer's own cart and Kroger answers 204",
    async () => {
      if (!store) throw new Error("no store from the previous step");
      const item = milk.find(
        (p) => p.upc && /^\d{13}$/.test(p.upc) && p.stockLevel !== "TEMPORARILY_OUT_OF_STOCK",
      );
      if (!item) throw new Error("no addable milk");
      const result = await adapter.addToCart(
        { connectionId: "live-smoke", retailer: "kroger", storeId: store.id, modality: "PICKUP" },
        [{ productId: item.id, upc: item.upc, quantityDelta: 1 }],
      );
      expect(result.rejected).toEqual([]);
      expect(result.accepted).toHaveLength(1);
      const put = statuses.filter((s) => s.method === "PUT" && s.path === "/v1/cart/add").at(-1);
      expect(put?.status).toBe(204);
      console.info(`live: cart add answered ${put?.status}`);
    },
  );
});
