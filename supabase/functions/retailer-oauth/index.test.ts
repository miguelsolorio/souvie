import { describe, expect, it, vi } from "vitest";
import cartAdd from "../../../packages/retailers/src/kroger/__fixtures__/cart-add.json";
import identityProfile from "../../../packages/retailers/src/kroger/__fixtures__/identity-profile.json";
import locations98019 from "../../../packages/retailers/src/kroger/__fixtures__/locations-98019.json";
import productsChickenThighs from "../../../packages/retailers/src/kroger/__fixtures__/products-chicken-thighs.json";
import {
  type RecordedResponse,
  replay,
  T0,
} from "../../../packages/retailers/src/kroger/__fixtures__/replay.ts";
import tokenAuthCode from "../../../packages/retailers/src/kroger/__fixtures__/token-authorization-code.json";
import tokenClientCredentials from "../../../packages/retailers/src/kroger/__fixtures__/token-client-credentials.json";
import {
  createRpcQuotaStore,
  createRpcVault,
  KrogerAdapter,
  type Rpc,
} from "../../../packages/retailers/src/kroger/index.ts";
import { handleRetailerOAuth, type Runtime } from "./handler.ts";
import type { ConnectionRow, RetailerStore } from "./store.ts";

// supabase-js is only needed by the real runtime; the tests inject their own.
vi.mock("./client.ts", () => ({ createClient: vi.fn() }));

const HOUSEHOLD = "0a000000-0000-4000-8000-00000000000a";
const OTHER_HOUSEHOLD = "0b000000-0000-4000-8000-00000000000b";
const ALICE = "a1111111-1111-4111-8111-111111111111";
const CAROL = "c3333333-3333-4333-8333-333333333333";
const BOB = "b2222222-2222-4222-8222-222222222222";
const REDIRECT = "souvie://oauth/kroger";
const TOKENS: Record<string, string> = {
  "Bearer alice": ALICE,
  "Bearer carol": CAROL,
  "Bearer bob": BOB,
};

type Row = ConnectionRow & { vault_secret_id: string | null };

/**
 * In-memory stand-in for the ws07_retail SQL functions, with the same rules: membership checks,
 * one secret per connection, rotation in place, disconnect deletes the secret.
 */
class FakeDb {
  members = [
    { household_id: HOUSEHOLD, user_id: ALICE, role: "owner" },
    { household_id: HOUSEHOLD, user_id: CAROL, role: "member" },
    { household_id: OTHER_HOUSEHOLD, user_id: BOB, role: "owner" },
  ];
  connections = new Map<string, Row>();
  vault = new Map<string, string>();
  quota = new Map<string, number>();
  #n = 0;

  #id(prefix: string): string {
    this.#n += 1;
    return `${prefix}000000-0000-4000-8000-${String(this.#n).padStart(12, "0")}`;
  }

  isMember(h: string, u: string) {
    return this.members.some((m) => m.household_id === h && m.user_id === u);
  }

  rpc: Rpc = async (fn, a) => {
    const err = (message: string) => ({ data: null, error: { message } });
    switch (fn) {
      case "retailer_save_oauth_connection": {
        const household = a.p_household_id as string;
        const user = a.p_user_id as string;
        if (!this.isMember(household, user)) return err("not_a_member");
        let row = [...this.connections.values()].find(
          (c) => c.household_id === household && c.user_id === user,
        );
        const secret = row?.vault_secret_id ?? this.#id("5ec");
        this.vault.set(secret, a.p_refresh_token as string);
        if (!row) {
          row = {
            id: this.#id("c0"),
            household_id: household,
            user_id: user,
            retailer: "kroger",
            auth_type: "oauth",
            status: "active",
            store_id: (a.p_store_id as string | null) ?? null,
            store_name: (a.p_store_name as string | null) ?? null,
            modality: ((a.p_modality as string | null) ?? "pickup") as Row["modality"],
            last_verified_at: new Date(T0).toISOString(),
            vault_secret_id: secret,
          };
          this.connections.set(row.id, row);
        } else {
          Object.assign(row, { status: "active", auth_type: "oauth", vault_secret_id: secret });
        }
        return { data: row.id, error: null };
      }
      case "retailer_read_refresh_token": {
        const row = this.connections.get(a.p_connection_id as string);
        if (!row || row.status === "revoked" || !row.vault_secret_id)
          return { data: null, error: null };
        return { data: this.vault.get(row.vault_secret_id) ?? null, error: null };
      }
      case "retailer_rotate_refresh_token": {
        const row = this.connections.get(a.p_connection_id as string);
        if (!row?.vault_secret_id) return err("connection_not_found");
        this.vault.set(row.vault_secret_id, a.p_refresh_token as string);
        return { data: null, error: null };
      }
      case "retailer_mark_needs_reauth": {
        const row = this.connections.get(a.p_connection_id as string);
        if (row?.status === "active") row.status = "needs_reauth";
        return { data: null, error: null };
      }
      case "retailer_disconnect": {
        const row = this.connections.get(a.p_connection_id as string);
        if (!row) return err("connection_not_found");
        const actor = a.p_actor_user_id as string;
        const owner = this.members.some(
          (m) => m.household_id === row.household_id && m.user_id === actor && m.role === "owner",
        );
        if (actor !== row.user_id && !owner) return err("not_allowed");
        if (row.vault_secret_id) this.vault.delete(row.vault_secret_id);
        Object.assign(row, { status: "revoked", vault_secret_id: null });
        return { data: null, error: null };
      }
      case "retailer_quota_consume": {
        const key = `${a.p_endpoint}|${a.p_day}`;
        const used = this.quota.get(key) ?? 0;
        const amount = a.p_amount as number;
        if (used + amount > (a.p_ceiling as number)) {
          return { data: [{ allowed: false, used }], error: null };
        }
        this.quota.set(key, used + amount);
        return { data: [{ allowed: true, used: used + amount }], error: null };
      }
      case "retailer_quota_raise": {
        const key = `${a.p_endpoint}|${a.p_day}`;
        this.quota.set(key, Math.max(this.quota.get(key) ?? 0, a.p_count as number));
        return { data: null, error: null };
      }
      default:
        return err(`unknown function ${fn}`);
    }
  };
}

class FakeStore implements RetailerStore {
  constructor(private readonly db: FakeDb) {}
  async isMember(h: string, u: string) {
    return this.db.isMember(h, u);
  }
  async connection(id: string): Promise<ConnectionRow | null> {
    const row = this.db.connections.get(id);
    if (!row) return null;
    const { vault_secret_id: _secret, ...visible } = row;
    return visible;
  }
  async disconnect(id: string, actor: string) {
    const { error } = await this.db.rpc("retailer_disconnect", {
      p_connection_id: id,
      p_actor_user_id: actor,
    });
    if (error) throw new Error(error.message);
  }
}

function setup(cart: RecordedResponse = cartAdd) {
  const db = new FakeDb();
  const http = replay([
    {
      method: "POST",
      path: "/v1/connect/oauth2/token",
      respond: (req) => {
        const grant = new URLSearchParams(req.body ?? "").get("grant_type");
        return grant === "client_credentials" ? tokenClientCredentials : tokenAuthCode;
      },
    },
    { path: "/v1/identity/profile", respond: identityProfile },
    { path: "/v1/locations", respond: locations98019 },
    { path: "/v1/products", respond: productsChickenThighs },
    { method: "PUT", path: "/v1/cart/add", respond: cart },
  ]);
  const kroger = new KrogerAdapter({
    clientId: "fixture-client-id",
    clientSecret: "fixture-client-secret",
    redirectUri: REDIRECT,
    fetch: http.fetch,
    now: () => T0,
    vault: createRpcVault(db.rpc),
    quotaStore: createRpcQuotaStore(db.rpc),
  });
  const runtime: Runtime = {
    authenticate: async (header) => (TOKENS[header] ? { userId: TOKENS[header] } : null),
    store: new FakeStore(db),
    kroger,
    redirectUri: REDIRECT,
  };
  const call = async (as: string | null, body: unknown, method = "POST") => {
    const res = await handleRetailerOAuth(
      new Request("http://localhost/functions/v1/retailer-oauth", {
        method,
        headers: { "content-type": "application/json", ...(as ? { authorization: as } : {}) },
        ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
      }),
      runtime,
    );
    return {
      status: res.status,
      headers: res.headers,
      body: (await res.json()) as Record<string, unknown>,
    };
  };
  return { db, http, call };
}

/** Starts a connection as `who` and returns the redirect Kroger would send back. */
async function recordedCallback(call: ReturnType<typeof setup>["call"], who = "Bearer alice") {
  const res = await call(who, { action: "authorize", householdId: HOUSEHOLD, chain: "QFC" });
  expect(res.status).toBe(200);
  const authorize = new URL(res.body.authorizeUrl as string);
  expect(authorize.searchParams.get("banner")).toBe("qfc");
  expect(authorize.searchParams.get("redirect_uri")).toBe(REDIRECT);
  const state = authorize.searchParams.get("state") ?? "";
  return new URL(`${REDIRECT}?code=recorded-code&state=${encodeURIComponent(state)}`);
}

describe("retailer-oauth: connect and disconnect", () => {
  it("turns a recorded callback into one active oauth connection with a Vault secret", async () => {
    const { db, call } = setup();
    const callback = await recordedCallback(call);

    const res = await call("Bearer alice", {
      action: "exchange",
      code: callback.searchParams.get("code"),
      state: callback.searchParams.get("state"),
      storeId: "70500999",
      storeName: "Quality Food Center - Fixture Ridge",
      modality: "PICKUP",
    });

    expect(res.status).toBe(200);
    expect(db.connections.size).toBe(1);
    const [row] = [...db.connections.values()];
    expect(row).toMatchObject({
      household_id: HOUSEHOLD,
      user_id: ALICE,
      auth_type: "oauth",
      status: "active",
      store_id: "70500999",
      modality: "pickup",
    });
    expect(row?.vault_secret_id).not.toBeNull();
    // Only the refresh token is stored, and only in Vault.
    expect([...db.vault.values()]).toEqual(["fixture-customer-refresh-token-1"]);

    // The app gets its connection back without the secret id or any token.
    expect(res.body.connection).toEqual({
      id: row?.id,
      householdId: HOUSEHOLD,
      userId: ALICE,
      retailer: "kroger",
      status: "active",
      storeId: "70500999",
      storeName: "Quality Food Center - Fixture Ridge",
      modality: "pickup",
      lastVerifiedAt: new Date(T0).toISOString(),
    });
    const text = JSON.stringify(res.body);
    expect(text).not.toContain("vault");
    expect(text).not.toContain("fixture-customer");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("disconnect deletes the Vault secret and sets status revoked", async () => {
    const { db, call } = setup();
    const callback = await recordedCallback(call);
    await call("Bearer alice", {
      action: "exchange",
      code: callback.searchParams.get("code"),
      state: callback.searchParams.get("state"),
    });
    const [row] = [...db.connections.values()];
    const secret = row?.vault_secret_id ?? "";
    expect(db.vault.has(secret)).toBe(true);

    const res = await call("Bearer alice", { action: "disconnect", connectionId: row?.id });

    expect(res.status).toBe(200);
    expect(db.vault.has(secret)).toBe(false);
    expect(db.vault.size).toBe(0);
    expect(db.connections.get(row?.id ?? "")).toMatchObject({
      status: "revoked",
      vault_secret_id: null,
    });
    expect(res.body.connection).toMatchObject({ status: "revoked" });
  });

  it("refuses a state that another user started", async () => {
    const { db, call } = setup();
    const callback = await recordedCallback(call, "Bearer alice");
    const res = await call("Bearer carol", {
      action: "exchange",
      code: callback.searchParams.get("code"),
      state: callback.searchParams.get("state"),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_state");
    expect(db.connections.size).toBe(0);
  });

  it("refuses a tampered state", async () => {
    const { call } = setup();
    const res = await call("Bearer alice", { action: "exchange", code: "c", state: "v1.abc.def" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_state");
  });

  it("will not start a connection for a household the caller is not in", async () => {
    const { call } = setup();
    const res = await call("Bearer bob", { action: "authorize", householdId: HOUSEHOLD });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("not_a_member");
  });

  it("lets only the account holder or an owner disconnect", async () => {
    const { db, call } = setup();
    const callback = await recordedCallback(call, "Bearer alice");
    await call("Bearer alice", {
      action: "exchange",
      code: callback.searchParams.get("code"),
      state: callback.searchParams.get("state"),
    });
    const [row] = [...db.connections.values()];
    const asCarol = await call("Bearer carol", { action: "disconnect", connectionId: row?.id });
    expect(asCarol.status).toBe(403);
    expect(asCarol.body.error).toBe("not_allowed");
    const asBob = await call("Bearer bob", { action: "disconnect", connectionId: row?.id });
    expect(asBob.status).toBe(404);
    expect(db.connections.get(row?.id ?? "")?.status).toBe("active");
  });
});

describe("retailer-oauth: catalog and cart for the app", () => {
  it("lists QFC and Fred Meyer stores near a ZIP", async () => {
    const { call } = setup();
    const res = await call("Bearer alice", { action: "stores", zip: "98019" });
    expect(res.status).toBe(200);
    expect((res.body.stores as { id: string }[]).map((s) => s.id)).toEqual([
      "70500999",
      "70100999",
    ]);
  });

  it("searches products at a store for a household member", async () => {
    const { http, call } = setup();
    const res = await call("Bearer alice", {
      action: "products",
      householdId: HOUSEHOLD,
      storeId: "70500999",
      q: "chicken thighs",
    });
    expect(res.status).toBe(200);
    expect((res.body.products as unknown[]).length).toBe(4);
    const req = http.requests.find((r) => r.url.pathname === "/v1/products");
    expect(req?.url.searchParams.get("filter.locationId")).toBe("70500999");
  });

  it("adds to the caller's own cart with the connection's modality", async () => {
    const { db, http, call } = setup();
    const callback = await recordedCallback(call);
    await call("Bearer alice", {
      action: "exchange",
      code: callback.searchParams.get("code"),
      state: callback.searchParams.get("state"),
      modality: "DELIVERY",
    });
    const [row] = [...db.connections.values()];
    const res = await call("Bearer alice", {
      action: "cart_add",
      connectionId: row?.id,
      items: [{ productId: "0009990001001", upc: "0009990001001", quantityDelta: 1 }],
    });
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual({
      accepted: [{ productId: "0009990001001", upc: "0009990001001", quantityDelta: 1 }],
      rejected: [],
    });
    const put = http.requests.find((r) => r.method === "PUT");
    expect(JSON.parse(put?.body ?? "{}")).toEqual({
      items: [{ upc: "0009990001001", quantity: 1, modality: "DELIVERY" }],
    });
    // The exchange's access token was reused: no refresh before the cart call.
    expect(db.vault.get(row?.vault_secret_id ?? "")).toBe("fixture-customer-refresh-token-1");
  });

  it("does not let one member fill another member's cart", async () => {
    const { db, call } = setup();
    const callback = await recordedCallback(call);
    await call("Bearer alice", {
      action: "exchange",
      code: callback.searchParams.get("code"),
      state: callback.searchParams.get("state"),
    });
    const [row] = [...db.connections.values()];
    const res = await call("Bearer carol", {
      action: "cart_add",
      connectionId: row?.id,
      items: [{ productId: "0009990001001", upc: null, quantityDelta: 1 }],
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("not_allowed");
  });

  it("validates cart items before calling Kroger", async () => {
    const { http, call } = setup();
    for (const items of [
      [],
      [{ productId: "x", upc: null, quantityDelta: 1 }],
      [{ productId: "0009990001001", upc: null, quantityDelta: 0 }],
      [{ productId: "0009990001001", upc: null, quantityDelta: 1.5 }],
    ]) {
      const res = await call("Bearer alice", {
        action: "cart_add",
        connectionId: "c0000000-0000-4000-8000-000000000001",
        items,
      });
      expect(res.status).toBe(400);
    }
    expect(http.requests).toHaveLength(0);
  });

  it("answers 429 with the reset time when the day's Products budget is spent", async () => {
    const { db, call } = setup();
    db.quota.set("products|2026-10-30", 9_500);
    const res = await call("Bearer alice", {
      action: "products",
      householdId: HOUSEHOLD,
      storeId: "70500999",
      q: "milk",
    });
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({
      error: "quota_exhausted",
      resetsAt: "2026-10-31T00:00:00.000Z",
    });
  });
});

describe("retailer-oauth: request handling", () => {
  it("needs a signed-in user", async () => {
    const { call } = setup();
    expect((await call(null, { action: "stores", zip: "98019" })).status).toBe(401);
    expect((await call("Bearer nobody", { action: "stores", zip: "98019" })).status).toBe(401);
  });

  it("accepts POST only, and a known action", async () => {
    const { call } = setup();
    expect((await call("Bearer alice", null, "GET")).status).toBe(405);
    const res = await call("Bearer alice", { action: "drop_tables" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect((await call("Bearer alice", { action: "stores", zip: "980" })).status).toBe(400);
  });
});
