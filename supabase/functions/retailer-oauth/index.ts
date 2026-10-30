// retailer-oauth (WS07): the server side of connecting a Kroger account, plus the Kroger calls
// the app may not make itself because they need the client secret or a customer token.
//
//   POST { "action": "authorize", "householdId", "banner"?: "qfc" | "fredmeyer", "chain"? }
//     -> { ok, authorizeUrl }          open it in the system browser
//   POST { "action": "exchange", "code", "state", "storeId"?, "storeName"?, "modality"? }
//     -> { ok, connection }            the app forwards souvie://oauth/kroger?code&state here
//   POST { "action": "disconnect", "connectionId" }            -> { ok, connection }
//   POST { "action": "stores", "zip", "radiusMiles"? }         -> { ok, stores }
//   POST { "action": "products", "householdId", "storeId", "q" } -> { ok, products }
//   POST { "action": "cart_add", "connectionId", "items": [{ productId, upc, quantityDelta }] }
//     -> { ok, result: { accepted, rejected } }
//
// Errors: { ok: false, error, message } with an HTTP status (handler.ts lists them). Needs a
// signed-in user (verify_jwt stays on). Secrets, set with `supabase secrets set`:
// KROGER_CLIENT_ID, KROGER_CLIENT_SECRET, KROGER_REDIRECT_URI; optional KROGER_API_BASE.

import {
  createRpcQuotaStore,
  createRpcVault,
  KrogerAdapter,
} from "../../../packages/retailers/src/kroger/index.ts";
import { createClient } from "./client.ts";
import { handleRetailerOAuth, type Runtime } from "./handler.ts";
import { rpcOf, SupabaseRetailerStore } from "./store.ts";

type Env = (name: string) => string | undefined;

/** Builds the real runtime from the environment Supabase provides plus the Kroger secrets. */
export function runtimeFromEnv(env: Env): Runtime {
  const url = env("SUPABASE_URL");
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  const clientId = env("KROGER_CLIENT_ID");
  const clientSecret = env("KROGER_CLIENT_SECRET");
  const redirectUri = env("KROGER_REDIRECT_URI");
  if (!url || !serviceKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("KROGER_CLIENT_ID, KROGER_CLIENT_SECRET, and KROGER_REDIRECT_URI are required");
  }
  const serviceDb = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const rpc = rpcOf(serviceDb);
  const baseUrl = env("KROGER_API_BASE")?.trim();
  const kroger = new KrogerAdapter({
    clientId,
    clientSecret,
    redirectUri,
    ...(baseUrl ? { baseUrl } : {}),
    vault: createRpcVault(rpc),
    quotaStore: createRpcQuotaStore(rpc),
  });

  return {
    async authenticate(authHeader) {
      const token = authHeader.replace(/^Bearer\s+/i, "");
      const { data, error } = await serviceDb.auth.getUser(token);
      return error || !data.user ? null : { userId: data.user.id };
    },
    store: new SupabaseRetailerStore(serviceDb),
    kroger,
    redirectUri,
  };
}

let cached: Runtime | undefined;

function runtime(): Runtime {
  if (!cached) {
    const deno = (globalThis as { Deno?: { env: { get(name: string): string | undefined } } }).Deno;
    cached = runtimeFromEnv((name) => deno?.env.get(name));
  }
  return cached;
}

export default {
  fetch(req: Request): Promise<Response> | Response {
    try {
      return handleRetailerOAuth(req, runtime());
    } catch (err) {
      console.error("retailer-oauth is misconfigured", (err as Error).message);
      return Response.json({ ok: false, error: "internal_error" }, { status: 500 });
    }
  },
};
