// Kroger Products API: GET /v1/products. Every call sends filter.locationId so price, promo,
// fulfillment, and stock come back. Nothing here is stored: results live in memory, bounded by
// their cache headers (cache.ts), and go straight back to the caller.
import type { Product, SearchOptions, Store } from "../types.ts";
import type { KrogerClient } from "./client.ts";
import { type KrogerList, type KrogerProduct, mapProduct } from "./mappers.ts";

/** filter.limit is 1 to 50. */
export const MAX_SEARCH_LIMIT = 50;
/** filter.productId takes up to 50 comma-separated ids. */
export const MAX_IDS_PER_REQUEST = 50;
/** filter.term needs 3 or more characters, at most 8 words, and fewer than 128 characters. */
export const MIN_TERM_LENGTH = 3;
export const MAX_TERM_WORDS = 8;
export const MAX_TERM_LENGTH = 127;

/**
 * A search term Kroger accepts, or null when there is nothing worth sending. Extra words past the
 * eighth are dropped (the query is ours to shape; product data is not).
 */
export function normalizeTerm(q: string): string | null {
  const words = q.trim().split(/\s+/).filter(Boolean).slice(0, MAX_TERM_WORDS);
  let term = words.join(" ");
  if (term.length > MAX_TERM_LENGTH) term = term.slice(0, MAX_TERM_LENGTH).trimEnd();
  return term.length >= MIN_TERM_LENGTH ? term : null;
}

export function searchParams(
  term: string,
  store: Store,
  opts: SearchOptions = {},
): URLSearchParams {
  const limit = Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.trunc(opts.limit ?? MAX_SEARCH_LIMIT)));
  const params = new URLSearchParams();
  params.set("filter.term", term);
  params.set("filter.locationId", store.id);
  params.set("filter.limit", String(limit));
  if (opts.brand) params.set("filter.brand", opts.brand);
  return params;
}

/** Searches one store. A term under 3 characters returns [] without a network call. */
export async function searchProducts(
  client: KrogerClient,
  q: string,
  store: Store,
  opts: SearchOptions = {},
): Promise<Product[]> {
  const term = normalizeTerm(q);
  if (!term) return [];
  const res = await client.catalog<KrogerList<KrogerProduct>>(
    "products",
    "/products",
    searchParams(term, store, opts),
  );
  return (res.body.data ?? []).map((raw) => mapProduct(raw, res.expiresAt));
}

/**
 * Batch lookup by product id for pinned items (R15: one call per 50 ids instead of a search per
 * item). Duplicate ids are sent once. Results come back in the order the ids were given; ids
 * Kroger did not return are left out.
 */
export async function getProducts(
  client: KrogerClient,
  ids: string[],
  store: Store,
): Promise<Product[]> {
  const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  const byId = new Map<string, Product>();
  for (let i = 0; i < unique.length; i += MAX_IDS_PER_REQUEST) {
    const chunk = unique.slice(i, i + MAX_IDS_PER_REQUEST);
    const params = new URLSearchParams();
    params.set("filter.productId", chunk.join(","));
    params.set("filter.locationId", store.id);
    params.set("filter.limit", String(chunk.length));
    const res = await client.catalog<KrogerList<KrogerProduct>>("products", "/products", params);
    for (const raw of res.body.data ?? []) byId.set(raw.productId, mapProduct(raw, res.expiresAt));
  }
  return unique.map((id) => byId.get(id)).filter((p): p is Product => p !== undefined);
}
