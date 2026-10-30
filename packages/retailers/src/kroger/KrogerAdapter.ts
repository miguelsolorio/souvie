// The production Kroger adapter (QFC and Fred Meyer), Tier 1: search and cart adds over the
// public API; slots and checkout hand off to kroger.com or the banner app.
//
// Hosts build one instance with their credentials: the worker (WS09) and the retailer-oauth Edge
// Function. The client secret never ships in the app bundle.
import { KROGER_CAPABILITIES } from "../capabilities.ts";
import { RetailerAuthError, RetailerNotSupportedError } from "../errors.ts";
import type {
  CartItemDelta,
  CartResult,
  ConnectContext,
  ConnectionHandle,
  ConnectResult,
  FindStoresOptions,
  Modality,
  Product,
  RetailerAdapter,
  SearchOptions,
  Store,
} from "../types.ts";
import {
  buildAuthorizeUrl,
  type CompletedAuthorization,
  CustomerTokenCache,
  completeAuthorization,
  createPkcePair,
  KROGER_API_BASE,
  KrogerAuth,
  type RefreshTokenVault,
  sealState,
} from "./auth.ts";
import { ResponseCache } from "./cache.ts";
import { addToCart } from "./cart.ts";
import { KrogerClient } from "./client.ts";
import { findStores, getStore } from "./locations.ts";
import { getProducts, searchProducts } from "./products.ts";
import { InMemoryQuotaStore, QuotaGuard, type QuotaStore } from "./quota.ts";

/** Where Tier 1 ends: the customer reviews and pays on Kroger's own checkout. */
export const KROGER_CHECKOUT_URL = "https://www.kroger.com/checkout";

export interface KrogerAdapterConfig {
  clientId: string;
  clientSecret: string;
  /** The registered redirect, souvie://oauth/kroger. Needed for connect and the code exchange. */
  redirectUri?: string;
  /** Production by default. The certification host has no customer accounts. */
  baseUrl?: string;
  /** Refresh tokens. Required for cart calls and the callback. */
  vault?: RefreshTokenVault;
  /** Daily counts. Defaults to memory, which is right only for tests and one-off tools. */
  quotaStore?: QuotaStore;
  /** Key material for the sealed OAuth state. Defaults to the client secret. */
  stateSecret?: string;
  fetch?: typeof fetch;
  now?: () => number;
  cacheMaxEntries?: number;
}

export interface CompleteConnectInput {
  code: string;
  state: string;
  userId: string;
  store?: Pick<Store, "id" | "name"> | null;
  modality?: Modality | null;
}

export class KrogerAdapter implements RetailerAdapter {
  readonly id = "kroger" as const;
  readonly capabilities = KROGER_CAPABILITIES;

  readonly #config: KrogerAdapterConfig;
  readonly #now: () => number;
  readonly #auth: KrogerAuth;
  readonly #client: KrogerClient;
  readonly #customer: { tokens: CustomerTokenCache; vault: RefreshTokenVault } | null;

  constructor(config: KrogerAdapterConfig) {
    this.#config = config;
    this.#now = config.now ?? Date.now;
    this.#auth = new KrogerAuth({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      baseUrl: config.baseUrl ?? KROGER_API_BASE,
      ...(config.fetch ? { fetch: config.fetch } : {}),
      now: this.#now,
    });
    const quota = new QuotaGuard({
      store: config.quotaStore ?? new InMemoryQuotaStore(),
      now: () => new Date(this.#now()),
    });
    this.#client = new KrogerClient({
      auth: this.#auth,
      quota,
      cache: new ResponseCache<unknown>({
        now: this.#now,
        maxEntries: config.cacheMaxEntries ?? 500,
      }),
      ...(config.fetch ? { fetch: config.fetch } : {}),
      now: this.#now,
    });
    this.#customer = config.vault
      ? { tokens: new CustomerTokenCache(this.#auth, config.vault, this.#now), vault: config.vault }
      : null;
  }

  #stateSecret(): string {
    return this.#config.stateSecret ?? this.#config.clientSecret;
  }

  #redirectUri(ctxUri?: string): string {
    const uri = ctxUri || this.#config.redirectUri;
    if (!uri) throw new Error("KrogerAdapter needs KROGER_REDIRECT_URI");
    return uri;
  }

  /**
   * Starts OAuth: returns the authorize URL to open in the system browser. The PKCE verifier and
   * the household travel inside the sealed state, so nothing is kept server side.
   */
  async connect(ctx: ConnectContext): Promise<ConnectResult> {
    const pkce = await createPkcePair();
    const state = await sealState(
      {
        householdId: ctx.householdId,
        userId: ctx.userId,
        verifier: pkce.verifier,
        ...(ctx.banner ? { banner: ctx.banner } : {}),
        now: this.#now(),
      },
      this.#stateSecret(),
    );
    const authorizeUrl = buildAuthorizeUrl({
      baseUrl: this.#auth.baseUrl,
      clientId: this.#auth.clientId,
      redirectUri: this.#redirectUri(ctx.redirectUri),
      state,
      codeChallenge: pkce.challenge,
      ...(ctx.banner ? { banner: ctx.banner } : {}),
    });
    return { authorizeUrl };
  }

  /** The OAuth callback: exchanges the code and stores the refresh token in Vault. */
  async completeConnect(input: CompleteConnectInput): Promise<CompletedAuthorization> {
    const { tokens, vault } = this.#requireCustomer();
    return completeAuthorization(
      {
        code: input.code,
        state: input.state,
        userId: input.userId,
        redirectUri: this.#redirectUri(),
        storeId: input.store?.id ?? null,
        storeName: input.store?.name ?? null,
        modality: input.modality ?? null,
      },
      {
        auth: this.#auth,
        vault,
        stateSecret: this.#stateSecret(),
        now: this.#now,
        tokens,
      },
    );
  }

  /**
   * GET /v1/identity/profile with the customer's token: proves the connection works. Returns
   * true when Kroger accepts it. The profile id is not kept.
   */
  async verifyConnection(conn: ConnectionHandle): Promise<boolean> {
    const { tokens } = this.#requireCustomer();
    const res = await this.#client.customer(
      "identity",
      "/identity/profile",
      { method: "GET" },
      await tokens.get(conn),
    );
    await res.body?.cancel();
    return res.ok;
  }

  findStores(zip: string, opts?: FindStoresOptions): Promise<Store[]> {
    return findStores(this.#client, zip, opts);
  }

  getStore(locationId: string): Promise<Store | null> {
    return getStore(this.#client, locationId);
  }

  searchProducts(q: string, store: Store, opts?: SearchOptions): Promise<Product[]> {
    return searchProducts(this.#client, q, store, opts);
  }

  getProducts(ids: string[], store: Store): Promise<Product[]> {
    return getProducts(this.#client, ids, store);
  }

  async addToCart(conn: ConnectionHandle, items: CartItemDelta[]): Promise<CartResult> {
    if (conn.retailer !== "kroger") {
      throw new RetailerNotSupportedError("kroger", "addToCart", "Not a Kroger connection");
    }
    const { tokens, vault } = this.#requireCustomer();
    return addToCart({ client: this.#client, tokens, vault }, conn, items);
  }

  /** Kroger checkout. The banner apps open the same cart. */
  async handoffUrl(): Promise<string> {
    return KROGER_CHECKOUT_URL;
  }

  #requireCustomer(): { tokens: CustomerTokenCache; vault: RefreshTokenVault } {
    if (!this.#customer) {
      throw new RetailerAuthError(
        "kroger",
        "missing_token",
        "No vault is configured for cart calls",
      );
    }
    return this.#customer;
  }
}
