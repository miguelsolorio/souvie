// Kroger Cart API, public tier: PUT /v1/cart/add only. No read, update, or delete. A negative
// quantity reduces a line. 204 means Kroger took the whole request.
//
// Idempotency is WS09's run ledger, not a cart read (docs/03-ai-design.md §8). Add only what the
// customer explicitly asked for (Kroger terms). Nothing about the cart is stored here.
import { RetailerAuthError } from "../errors.ts";
import type { CartItemDelta, CartResult, ConnectionHandle, Modality } from "../types.ts";
import type { CustomerTokenCache, RefreshTokenVault } from "./auth.ts";
import { errorFrom, type KrogerClient } from "./client.ts";

/** Kroger documents no per-request item limit; 50 keeps one bad line from sinking a long cart. */
export const MAX_CART_ITEMS_PER_REQUEST = 50;

export interface KrogerCartItem {
  upc: string;
  quantity: number;
  modality: Modality;
}

/** A 13-digit Kroger UPC. Shorter numeric codes (UPC-A, EAN-8) are left-padded with zeros. */
export function normalizeUpc(value: string | null | undefined): string | null {
  const digits = value?.trim() ?? "";
  if (!/^\d{8,13}$/.test(digits)) return null;
  return digits.padStart(13, "0");
}

export interface PreparedCart {
  ready: { item: CartItemDelta; line: KrogerCartItem }[];
  rejected: CartResult["rejected"];
}

/** Validates deltas and turns them into Kroger lines. Modality falls back to the connection's. */
export function prepareCartItems(conn: ConnectionHandle, items: CartItemDelta[]): PreparedCart {
  const ready: PreparedCart["ready"] = [];
  const rejected: CartResult["rejected"] = [];
  for (const item of items) {
    if (!Number.isInteger(item.quantityDelta) || item.quantityDelta === 0) {
      rejected.push({ item, reason: "quantityDelta must be a non-zero integer" });
      continue;
    }
    // Kroger product ids are the 13-digit UPC, so the id is a safe fallback when upc is missing.
    const upc = normalizeUpc(item.upc) ?? normalizeUpc(item.productId);
    if (!upc) {
      rejected.push({ item, reason: "no 13-digit UPC for this product" });
      continue;
    }
    ready.push({
      item,
      line: {
        upc,
        quantity: item.quantityDelta,
        modality: item.modality ?? conn.modality ?? "PICKUP",
      },
    });
  }
  return { ready, rejected };
}

export interface CartDeps {
  client: KrogerClient;
  tokens: CustomerTokenCache;
  vault: RefreshTokenVault;
}

/** Kroger answers 401 for an expired token and 403 (AUTH-1007) for one without cart scope. */
function isAuthFailure(status: number): boolean {
  return status === 401 || status === 403;
}

/**
 * Sends the deltas in chunks. A 401 triggers one refresh and one retry; a second 401 flips the
 * connection to needs_reauth and throws RetailerAuthError (or, when earlier chunks already landed,
 * rejects the rest so the result says exactly what is in the cart). Any other refusal rejects that
 * chunk with Kroger's reason and moves on.
 */
export async function addToCart(
  deps: CartDeps,
  conn: ConnectionHandle,
  items: CartItemDelta[],
): Promise<CartResult> {
  const { ready, rejected } = prepareCartItems(conn, items);
  const accepted: CartItemDelta[] = [];

  for (let i = 0; i < ready.length; i += MAX_CART_ITEMS_PER_REQUEST) {
    const chunk = ready.slice(i, i + MAX_CART_ITEMS_PER_REQUEST);
    const body = { items: chunk.map((c) => c.line) };

    let res = await deps.client.customer(
      "cart",
      "/cart/add",
      { method: "PUT", body },
      await deps.tokens.get(conn),
    );
    if (isAuthFailure(res.status)) {
      const fresh = await deps.tokens.refresh(conn);
      res = await deps.client.customer(
        "cart",
        "/cart/add",
        { method: "PUT", body },
        fresh.accessToken,
      );
      if (isAuthFailure(res.status)) {
        deps.tokens.invalidate(conn.connectionId);
        await deps.vault.markNeedsReauth(conn.connectionId);
        const error = new RetailerAuthError(
          "kroger",
          "unauthorized",
          "Kroger refused this connection",
          {
            connectionId: conn.connectionId,
            needsReauth: true,
          },
        );
        // Nothing sent yet: the caller gets the typed error. Some chunks already in the cart: the
        // caller gets an exact account of what landed, so the run ledger stays true.
        if (accepted.length === 0) throw error;
        for (const c of ready.slice(i))
          rejected.push({ item: c.item, reason: `needs_reauth: ${error.message}` });
        break;
      }
    }
    if (res.status === 204 || res.ok) {
      accepted.push(...chunk.map((c) => c.item));
      continue;
    }
    const err = await errorFrom(res);
    for (const c of chunk) rejected.push({ item: c.item, reason: err.message });
  }

  return { accepted, rejected };
}
