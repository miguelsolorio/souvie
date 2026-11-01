// Which RetailerAdapter a run gets. The worker hosts API adapters only (docs/04 §Tier 3: browser
// adapters run on the person's device, never from a cloud IP).
//
//   live (default)  Kroger with this worker's client credentials, refresh tokens in Vault through
//                   WS07's service-role functions, and the shared quota counter.
//   mock            MockRetailer for every retailer: local development, the CI smoke run, and the
//                   app's "MockRetailer" dev setting. Never in production.
import { AdapterRegistry, type RetailerAdapter, type RetailerId, type Store } from "@mp/retailers";
import { createRpcQuotaStore, createRpcVault, KrogerAdapter, type Rpc } from "@mp/retailers/kroger";
import { MockRetailer } from "@mp/retailers/mock";

export const RETAILER_MODES = ["live", "mock"] as const;
export type RetailerMode = (typeof RETAILER_MODES)[number];

export interface AdapterSource {
  readonly mode: RetailerMode;
  get(retailer: RetailerId): RetailerAdapter | null;
  /** The Store the adapter searches, for a run's connection. */
  storeFor(
    adapter: RetailerAdapter,
    storeId: string | null,
    storeName: string | null,
  ): Promise<Store>;
}

export interface AdapterSourceOptions {
  mode: RetailerMode;
  rpc: Rpc;
  kroger?: {
    clientId?: string | undefined;
    clientSecret?: string | undefined;
    baseUrl?: string | undefined;
  };
}

export function createAdapterSource(options: AdapterSourceOptions): AdapterSource {
  const registry = new AdapterRegistry();
  if (options.mode === "mock") {
    for (const id of ["kroger", "safeway", "costco"] as const) {
      registry.register(new MockRetailer({ id, seed: 1 }));
    }
  } else if (options.kroger?.clientId && options.kroger.clientSecret) {
    registry.register(
      new KrogerAdapter({
        clientId: options.kroger.clientId,
        clientSecret: options.kroger.clientSecret,
        ...(options.kroger.baseUrl ? { baseUrl: options.kroger.baseUrl } : {}),
        vault: createRpcVault(options.rpc),
        quotaStore: createRpcQuotaStore(options.rpc),
      }),
    );
  }

  return {
    mode: options.mode,
    get(retailer) {
      return registry.isAdapterAvailable(retailer) ? registry.getAdapter(retailer) : null;
    },
    async storeFor(adapter, storeId, storeName) {
      if (adapter instanceof MockRetailer) {
        const stores = await adapter.findStores("");
        const store = stores.find((s) => s.id === storeId) ?? stores[0];
        if (!store) throw new Error("the mock has no stores");
        return store;
      }
      if (!storeId) throw new Error("the connection has no store");
      // The connection already names the store; a Locations call would only spend quota.
      return {
        id: storeId,
        retailer: adapter.id,
        chain: "",
        name: storeName ?? "your store",
        address: "",
        zip: "",
        lat: 0,
        lng: 0,
      };
    },
  };
}
