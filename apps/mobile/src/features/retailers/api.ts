// Calls to the retailer-oauth Edge Function (WS07). The app never holds the Kroger client secret
// or a customer token: everything that needs them goes through the function.
//
// Kroger data that comes back (stores, products) lives in memory only. Products are recorded
// with the terms guard on arrival so components can prove they render them unchanged.
import type { MpClient } from "@mp/db";
import type { Banner, CartItemDelta, CartResult, Modality, Product, Store } from "@mp/retailers";
import { rememberReturned } from "@mp/retailers/kroger/terms";
import { FunctionsHttpError } from "@supabase/supabase-js";

export const RETAILER_FUNCTION = "retailer-oauth";

/** A connection as the function returns it. The Vault secret id never reaches the app. */
export interface RetailerConnection {
  id: string;
  householdId: string;
  userId: string;
  retailer: string;
  status: "active" | "needs_reauth" | "revoked";
  storeId: string | null;
  storeName: string | null;
  modality: "pickup" | "delivery";
  lastVerifiedAt: string | null;
}

export class RetailerApiError extends Error {
  readonly code: string;
  readonly resetsAt: string | undefined;

  constructor(code: string, message: string, resetsAt?: string) {
    super(message);
    this.name = "RetailerApiError";
    this.code = code;
    this.resetsAt = resetsAt;
  }
}

/** Text for the person using the app. */
export function retailerErrorMessage(error: unknown): string {
  if (error instanceof RetailerApiError) return error.message;
  return "Something went wrong. Try again.";
}

async function call<T>(client: MpClient, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.functions.invoke(RETAILER_FUNCTION, { body });
  let payload: unknown = data;
  if (error) {
    if (!(error instanceof FunctionsHttpError)) {
      throw new RetailerApiError(
        "network",
        "We could not reach the server. Check your connection.",
      );
    }
    payload = await error.context.json().catch(() => null);
  }
  const result = payload as
    | ({ ok: true } & T)
    | { ok: false; error: string; message: string; resetsAt?: string }
    | null;
  if (!result || typeof result !== "object") {
    throw new RetailerApiError("internal_error", "The server sent an answer we could not read.");
  }
  if (!result.ok) throw new RetailerApiError(result.error, result.message, result.resetsAt);
  return result;
}

export async function startKrogerAuthorization(
  client: MpClient,
  args: { householdId: string; banner?: Banner | undefined },
): Promise<string> {
  const { authorizeUrl } = await call<{ authorizeUrl: string }>(client, {
    action: "authorize",
    householdId: args.householdId,
    ...(args.banner ? { banner: args.banner } : {}),
  });
  return authorizeUrl;
}

export async function exchangeKrogerCode(
  client: MpClient,
  args: {
    code: string;
    state: string;
    store?: Pick<Store, "id" | "name"> | null;
    modality?: Modality | null;
  },
): Promise<RetailerConnection> {
  const { connection } = await call<{ connection: RetailerConnection }>(client, {
    action: "exchange",
    code: args.code,
    state: args.state,
    ...(args.store ? { storeId: args.store.id, storeName: args.store.name } : {}),
    ...(args.modality ? { modality: args.modality } : {}),
  });
  return connection;
}

export async function disconnectRetailer(
  client: MpClient,
  connectionId: string,
): Promise<RetailerConnection | null> {
  const { connection } = await call<{ connection: RetailerConnection | null }>(client, {
    action: "disconnect",
    connectionId,
  });
  return connection;
}

export async function findKrogerStores(client: MpClient, zip: string): Promise<Store[]> {
  const { stores } = await call<{ stores: Store[] }>(client, { action: "stores", zip });
  return stores;
}

export async function searchKrogerProducts(
  client: MpClient,
  args: { householdId: string; storeId: string; q: string },
): Promise<Product[]> {
  const { products } = await call<{ products: Product[] }>(client, {
    action: "products",
    ...args,
  });
  for (const product of products) rememberReturned(product);
  return products;
}

export async function addToKrogerCart(
  client: MpClient,
  args: { connectionId: string; items: CartItemDelta[] },
): Promise<{ result: CartResult; checkoutUrl: string }> {
  return call<{ result: CartResult; checkoutUrl: string }>(client, {
    action: "cart_add",
    connectionId: args.connectionId,
    items: args.items,
  });
}
