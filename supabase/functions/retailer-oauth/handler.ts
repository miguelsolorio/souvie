// retailer-oauth request handling (WS07). No Deno globals and no supabase-js here: the handler
// takes a `Runtime`, so Vitest drives it with fakes (index.test.ts). index.ts builds the real one.
//
// The Kroger client secret and every customer token stay on this side. The app only ever sees an
// authorize URL, its own connection row (without the Vault secret id), store lists, and, for the
// dev catalog explorer, products and cart results.

import {
  type Banner,
  type CartItemDelta,
  type ConnectionHandle,
  type Modality,
  type Product,
  RetailerAuthError,
  RetailerQuotaError,
  RetailerRequestError,
  type Store,
} from "../../../packages/retailers/src/index.ts";
import {
  bannerForChain,
  type CompleteConnectInput,
  type CompletedAuthorization,
  isZip,
  MAX_CART_ITEMS_PER_REQUEST,
} from "../../../packages/retailers/src/kroger/index.ts";
import type { ConnectionRow, RetailerStore } from "./store.ts";

/** The parts of KrogerAdapter this function uses. */
export interface KrogerOps {
  connect(ctx: {
    householdId: string;
    userId: string;
    redirectUri: string;
    banner?: Banner;
  }): Promise<{ authorizeUrl?: string }>;
  completeConnect(input: CompleteConnectInput): Promise<CompletedAuthorization>;
  verifyConnection(conn: ConnectionHandle): Promise<boolean>;
  findStores(zip: string, opts?: { radiusMiles?: number }): Promise<Store[]>;
  searchProducts(q: string, store: Store, opts?: { limit?: number }): Promise<Product[]>;
  addToCart(
    conn: ConnectionHandle,
    items: CartItemDelta[],
  ): Promise<{ accepted: CartItemDelta[]; rejected: { item: CartItemDelta; reason: string }[] }>;
}

export interface Runtime {
  authenticate(authHeader: string): Promise<{ userId: string } | null>;
  store: RetailerStore;
  kroger: KrogerOps;
  /** KROGER_REDIRECT_URI: the app deep link registered with Kroger. */
  redirectUri: string;
}

export const MAX_BODY_BYTES = 20_000;

export type ErrorCode =
  | "unauthorized"
  | "method_not_allowed"
  | "invalid_request"
  | "not_a_member"
  | "not_found"
  | "not_allowed"
  | "invalid_state"
  | "invalid_grant"
  | "reauth_required"
  | "quota_exhausted"
  | "retailer_error"
  | "internal_error";

const MESSAGES: Record<ErrorCode, string> = {
  unauthorized: "Sign in again.",
  method_not_allowed: "Use POST.",
  invalid_request: "The request is not valid.",
  not_a_member: "You are not a member of that household.",
  not_found: "That connection does not exist.",
  not_allowed: "Only the account holder or a household owner can do that.",
  invalid_state: "The Kroger sign-in expired or did not start here. Try connecting again.",
  invalid_grant: "Kroger did not accept the sign-in. Try connecting again.",
  reauth_required: "Reconnect your Kroger account to keep going.",
  quota_exhausted: "Kroger is busy for today. Try again after midnight UTC.",
  retailer_error: "Kroger did not answer as expected. Try again shortly.",
  internal_error: "Something went wrong on our side.",
};

const STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  method_not_allowed: 405,
  invalid_request: 400,
  not_a_member: 403,
  not_found: 404,
  not_allowed: 403,
  invalid_state: 400,
  invalid_grant: 400,
  reauth_required: 409,
  quota_exhausted: 429,
  retailer_error: 502,
  internal_error: 500,
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/** Kroger data must not be cached past its own headers, so nothing here is cacheable at all. */
function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } });
}

function fail(error: ErrorCode, extra: Record<string, unknown> = {}, message?: string): Response {
  return json({ ok: false, error, message: message ?? MESSAGES[error], ...extra }, STATUS[error]);
}

class BadRequest extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCATION_ID = /^[A-Za-z0-9]{8}$/;

type Body = Record<string, unknown>;

function str(body: Body, key: string, opts: { max?: number; optional?: boolean } = {}): string {
  const value = body[key];
  if (value === undefined || value === null || value === "") {
    if (opts.optional) return "";
    throw new BadRequest(`${key} is required`);
  }
  if (typeof value !== "string" || value.length > (opts.max ?? 2000)) {
    throw new BadRequest(`${key} must be a string`);
  }
  return value;
}

function uuid(body: Body, key: string): string {
  const value = str(body, key, { max: 36 });
  if (!UUID.test(value)) throw new BadRequest(`${key} must be a uuid`);
  return value;
}

function modalityOf(value: unknown): Modality | null {
  if (value === undefined || value === null) return null;
  if (value === "PICKUP" || value === "DELIVERY") return value;
  if (value === "pickup" || value === "delivery") return value.toUpperCase() as Modality;
  throw new BadRequest("modality must be PICKUP or DELIVERY");
}

function bannerOf(body: Body): Banner | undefined {
  if (body.banner === "qfc" || body.banner === "fredmeyer") return body.banner;
  if (body.banner !== undefined && body.banner !== null) {
    throw new BadRequest("banner must be qfc or fredmeyer");
  }
  return typeof body.chain === "string" ? bannerForChain(body.chain) : undefined;
}

/** The app's view of a connection: never the Vault secret id. */
export function publicConnection(row: ConnectionRow) {
  return {
    id: row.id,
    householdId: row.household_id,
    userId: row.user_id,
    retailer: row.retailer,
    status: row.status,
    storeId: row.store_id,
    storeName: row.store_name,
    modality: row.modality,
    lastVerifiedAt: row.last_verified_at,
  };
}

function handleFor(row: ConnectionRow): ConnectionHandle {
  return {
    connectionId: row.id,
    retailer: "kroger",
    storeId: row.store_id,
    modality: row.modality === "delivery" ? "DELIVERY" : "PICKUP",
  };
}

/** A store reference good enough for product calls: Kroger needs only the locationId. */
function storeRef(id: string): Store {
  return { id, retailer: "kroger", chain: "", name: "", address: "", zip: "", lat: 0, lng: 0 };
}

async function requireMember(runtime: Runtime, householdId: string, userId: string) {
  if (!(await runtime.store.isMember(householdId, userId))) throw new NotMember();
}

class NotMember extends Error {}

function retailerFailure(err: unknown): Response | null {
  if (err instanceof RetailerQuotaError) {
    return fail("quota_exhausted", { resetsAt: err.resetsAt });
  }
  if (err instanceof RetailerAuthError) {
    if (err.reason === "invalid_state" || err.reason === "expired_state") {
      return fail("invalid_state");
    }
    if (err.reason === "state_mismatch") return fail("invalid_state");
    if (err.reason === "invalid_grant") return fail("invalid_grant");
    if (err.needsReauth) return fail("reauth_required");
    console.error("retailer-oauth: Kroger refused the app credentials", err.code);
    return fail("retailer_error");
  }
  if (err instanceof RetailerRequestError) {
    console.error("retailer-oauth: Kroger request failed", err.status, err.retailerCode);
    return fail("retailer_error");
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------

async function authorize(runtime: Runtime, userId: string, body: Body): Promise<Response> {
  const householdId = uuid(body, "householdId");
  await requireMember(runtime, householdId, userId);
  const banner = bannerOf(body);
  const { authorizeUrl } = await runtime.kroger.connect({
    householdId,
    userId,
    redirectUri: runtime.redirectUri,
    ...(banner ? { banner } : {}),
  });
  return json({ ok: true, authorizeUrl });
}

async function exchange(runtime: Runtime, userId: string, body: Body): Promise<Response> {
  const code = str(body, "code", { max: 4096 });
  const state = str(body, "state", { max: 4096 });
  const storeId = str(body, "storeId", { optional: true, max: 8 });
  const storeName = str(body, "storeName", { optional: true, max: 200 });
  if (storeId && !LOCATION_ID.test(storeId)) throw new BadRequest("storeId must be a locationId");
  const modality = modalityOf(body.modality);

  let done: CompletedAuthorization;
  try {
    done = await runtime.kroger.completeConnect({
      code,
      state,
      userId,
      store: storeId ? { id: storeId, name: storeName } : null,
      modality,
    });
  } catch (err) {
    if (err instanceof Error && /not_a_member/.test(err.message)) throw new NotMember();
    throw err;
  }
  // Proves the token works (identity profile). Best effort: the connection is saved either way.
  try {
    await runtime.kroger.verifyConnection(done.handle);
  } catch (err) {
    console.warn("retailer-oauth: identity check after connect failed", (err as Error).name);
  }
  const row = await runtime.store.connection(done.handle.connectionId);
  if (!row) return fail("internal_error");
  return json({ ok: true, connection: publicConnection(row) });
}

async function disconnect(runtime: Runtime, userId: string, body: Body): Promise<Response> {
  const connectionId = uuid(body, "connectionId");
  const row = await runtime.store.connection(connectionId);
  if (!row || !(await runtime.store.isMember(row.household_id, userId))) return fail("not_found");
  try {
    await runtime.store.disconnect(connectionId, userId);
  } catch (err) {
    if (err instanceof Error && /not_allowed/.test(err.message)) return fail("not_allowed");
    throw err;
  }
  const after = await runtime.store.connection(connectionId);
  return json({ ok: true, connection: after ? publicConnection(after) : null });
}

async function stores(runtime: Runtime, _userId: string, body: Body): Promise<Response> {
  const zip = str(body, "zip", { max: 10 }).trim();
  if (!isZip(zip)) throw new BadRequest("zip must be 5 digits");
  const radius = body.radiusMiles;
  if (radius !== undefined && (typeof radius !== "number" || !Number.isFinite(radius))) {
    throw new BadRequest("radiusMiles must be a number");
  }
  const found = await runtime.kroger.findStores(
    zip,
    radius === undefined ? {} : { radiusMiles: radius },
  );
  return json({ ok: true, stores: found });
}

async function products(runtime: Runtime, userId: string, body: Body): Promise<Response> {
  const householdId = uuid(body, "householdId");
  await requireMember(runtime, householdId, userId);
  const storeId = str(body, "storeId", { max: 8 });
  if (!LOCATION_ID.test(storeId)) throw new BadRequest("storeId must be a locationId");
  const q = str(body, "q", { max: 200 });
  const found = await runtime.kroger.searchProducts(q, storeRef(storeId), { limit: 50 });
  return json({ ok: true, products: found });
}

function cartItems(value: unknown): CartItemDelta[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CART_ITEMS_PER_REQUEST) {
    throw new BadRequest(`items must hold 1 to ${MAX_CART_ITEMS_PER_REQUEST} entries`);
  }
  return value.map((raw, i) => {
    const item = (raw ?? {}) as Body;
    const productId = item.productId;
    const upc = item.upc ?? null;
    const quantityDelta = item.quantityDelta;
    if (typeof productId !== "string" || !/^[0-9]{8,14}$/.test(productId)) {
      throw new BadRequest(`items[${i}].productId is not a product id`);
    }
    if (upc !== null && (typeof upc !== "string" || !/^[0-9]{8,14}$/.test(upc))) {
      throw new BadRequest(`items[${i}].upc is not a UPC`);
    }
    if (typeof quantityDelta !== "number" || !Number.isInteger(quantityDelta)) {
      throw new BadRequest(`items[${i}].quantityDelta must be an integer`);
    }
    if (quantityDelta === 0 || Math.abs(quantityDelta) > 99) {
      throw new BadRequest(`items[${i}].quantityDelta must be between -99 and 99, not 0`);
    }
    const modality = modalityOf(item.modality);
    return { productId, upc, quantityDelta, ...(modality ? { modality } : {}) };
  });
}

/** Adds to the caller's own cart only: a person can fill nobody's cart but their own. */
async function cartAdd(runtime: Runtime, userId: string, body: Body): Promise<Response> {
  const connectionId = uuid(body, "connectionId");
  const items = cartItems(body.items);
  const row = await runtime.store.connection(connectionId);
  if (!row || !(await runtime.store.isMember(row.household_id, userId))) return fail("not_found");
  if (row.user_id !== userId) return fail("not_allowed");
  if (row.status !== "active") return fail("reauth_required");
  const result = await runtime.kroger.addToCart(handleFor(row), items);
  return json({ ok: true, result });
}

const ACTIONS = {
  authorize,
  exchange,
  disconnect,
  stores,
  products,
  cart_add: cartAdd,
} as const;

export type Action = keyof typeof ACTIONS;

export async function handleRetailerOAuth(req: Request, runtime: Runtime): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return fail("method_not_allowed");

  const authHeader = req.headers.get("authorization");
  if (!authHeader || !/^Bearer\s+\S+/i.test(authHeader)) return fail("unauthorized");
  let user: { userId: string } | null = null;
  try {
    user = await runtime.authenticate(authHeader);
  } catch (err) {
    console.error("retailer-oauth: auth check failed", (err as Error).name);
  }
  if (!user) return fail("unauthorized");

  let body: Body;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES)
      return fail("invalid_request", {}, "The request is too large.");
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("not an object");
    body = parsed as Body;
  } catch {
    return fail("invalid_request", {}, "The request body is not a JSON object.");
  }

  const action = body.action;
  if (typeof action !== "string" || !Object.hasOwn(ACTIONS, action)) {
    return fail("invalid_request", {}, `action must be one of ${Object.keys(ACTIONS).join(", ")}.`);
  }

  try {
    return await ACTIONS[action as Action](runtime, user.userId, body);
  } catch (err) {
    if (err instanceof BadRequest) return fail("invalid_request", {}, err.message);
    if (err instanceof NotMember) return fail("not_a_member");
    const mapped = retailerFailure(err);
    if (mapped) return mapped;
    // Never log the error text from the token path: it can echo request parameters.
    console.error(`retailer-oauth: ${action} failed`, (err as Error).name);
    return fail("internal_error");
  }
}
