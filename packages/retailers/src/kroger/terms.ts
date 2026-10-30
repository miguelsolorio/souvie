// Kroger terms guard. The developer terms require product data be displayed "exactly as it is
// returned": no changes to name, description, or price; images uncropped, with no overlays.
//
// How it works: when the app receives products from our Edge Function it records them with
// rememberReturned. Components that render Kroger data call assertDisplayUnchanged(product,
// rendered) with what they are about to show. A product that drifted from what was received, or a
// rendered string that is not the field verbatim, throws RetailerTermsError.
//
// What is kept, and for how long (R21: no cached copies past the response's cache headers):
//   * Only a salted hash of each product's id and display fields. No name, price, or image URL is
//     retained, so the guard is not a price list.
//   * A record expires at the product's `cacheUntil`. When the response carried no cache header
//     (Kroger sends none today), `cacheUntil` is the fetch time and the record lives only as long
//     as the fetch's results do: until the caller releases the set, for example when a new search
//     replaces it or the screen unmounts.
//   * At most MAX_RECORDS hashes; the oldest go first.
//
// Rendering rules the guard cannot see, which components must follow:
//   * Show the whole name. No numberOfLines truncation, no ellipsis, no case transforms.
//   * Images use resizeMode "contain" and nothing is drawn on top of them.
//   * Fulfillment flags and stock levels mean "approved for", not "on the shelf". Say so.
//   * No other retailer's price on the same screen.
import { RetailerTermsError } from "../errors.ts";
import type { Product } from "../types.ts";

/** The fields Kroger's terms protect. */
export const DISPLAY_FIELDS = [
  "name",
  "brand",
  "size",
  "price",
  "promoPrice",
  "imageUrl",
] as const satisfies readonly (keyof Product)[];

/** Hashes remembered at most across all live result sets. */
const MAX_RECORDS = 2_000;

/** Per process, so a hash means nothing outside it. */
const SALT = `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

/** One result set's claim on a record. `until` null: until the set is released. */
interface Hold {
  until: number | null;
}

const records = new Map<string, Set<Hold>>();

/** cyrb53: a fast 53-bit string hash. Two seeds give about 106 bits. Not for secrecy. */
function cyrb53(text: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

function fingerprint(product: Product): string {
  const text = JSON.stringify([
    SALT,
    product.id,
    product.name,
    product.brand,
    product.size,
    product.price,
    product.promoPrice,
    product.imageUrl,
  ]);
  return `${cyrb53(text, 1).toString(36)}.${cyrb53(text, 7).toString(36)}`;
}

function alive(key: string, now: number): boolean {
  const holds = records.get(key);
  if (!holds) return false;
  for (const hold of holds) {
    if (hold.until !== null && now >= hold.until) holds.delete(hold);
  }
  if (holds.size === 0) {
    records.delete(key);
    return false;
  }
  return true;
}

/** A batch of products the app received. Release it when its results leave the screen. */
export interface ReturnedSet {
  readonly size: number;
  release(): void;
}

/**
 * Records products exactly as the retailer returned them, as salted hashes only. Each record
 * expires at the product's `cacheUntil`, or, when the response had no cache header, when the
 * returned set is released.
 */
export function rememberReturned(
  products: Product | readonly Product[],
  options: { now?: number } = {},
): ReturnedSet {
  const now = options.now ?? Date.now();
  const list: readonly Product[] = Array.isArray(products) ? products : [products as Product];
  const mine: [string, Hold][] = [];
  for (const product of list) {
    const key = fingerprint(product);
    const cacheUntil = Date.parse(product.cacheUntil);
    const hold: Hold = {
      until: Number.isFinite(cacheUntil) && cacheUntil > now ? cacheUntil : null,
    };
    const holds = records.get(key) ?? new Set<Hold>();
    records.delete(key);
    holds.add(hold);
    records.set(key, holds);
    mine.push([key, hold]);
  }
  while (records.size > MAX_RECORDS) {
    const oldest = records.keys().next().value;
    if (oldest === undefined) break;
    records.delete(oldest);
  }
  let released = false;
  return {
    size: mine.length,
    release() {
      if (released) return;
      released = true;
      for (const [key, hold] of mine) {
        const holds = records.get(key);
        if (!holds) continue;
        holds.delete(hold);
        if (holds.size === 0) records.delete(key);
      }
    },
  };
}

/** Formats a price for display: dollars and cents, without rounding what Kroger sent. */
export function formatPrice(price: number): string {
  const cents = price * 100;
  return Math.abs(cents - Math.round(cents)) < 1e-9 ? `$${price.toFixed(2)}` : `$${String(price)}`;
}

export interface RenderedDisplay {
  name?: string;
  brand?: string | null;
  size?: string | null;
  /** The price text as shown, for example "$4.99". */
  price?: string | null;
  promoPrice?: string | null;
  imageUrl?: string | null;
}

function fail(field: string, message: string): never {
  throw new RetailerTermsError("kroger", field, message);
}

/**
 * Throws RetailerTermsError unless `product` matches, field for field, a live record of what the
 * retailer returned, and every rendered string is that field verbatim (prices through
 * formatPrice). Call it in render. An expired or released record fails: fetch again.
 */
export function assertDisplayUnchanged(
  product: Product,
  rendered: RenderedDisplay = {},
  options: { now?: number } = {},
): void {
  if (!alive(fingerprint(product), options.now ?? Date.now())) {
    fail(
      "display",
      `Product ${product.id} does not match what the retailer returned, or that data has expired`,
    );
  }
  const text: Record<keyof RenderedDisplay, string | null> = {
    name: product.name,
    brand: product.brand,
    size: product.size,
    price: product.price === null ? null : formatPrice(product.price),
    promoPrice: product.promoPrice === null ? null : formatPrice(product.promoPrice),
    imageUrl: product.imageUrl,
  };
  for (const key of Object.keys(rendered) as (keyof RenderedDisplay)[]) {
    const shown = rendered[key];
    if (shown === undefined) continue;
    if (shown !== text[key]) {
      fail(key, `Rendered ${key} for product ${product.id} is not the returned value verbatim`);
    }
  }
}

/** True when assertDisplayUnchanged would pass. For conditional rendering and tests. */
export function isDisplayUnchanged(
  product: Product,
  rendered: RenderedDisplay = {},
  options: { now?: number } = {},
): boolean {
  try {
    assertDisplayUnchanged(product, rendered, options);
    return true;
  } catch {
    return false;
  }
}

/** How many records are live. For tests and diagnostics. */
export function returnedRecordCount(): number {
  return records.size;
}

/** The record keys (hashes) that are live. For tests: shows that no display value is kept. */
export function returnedRecordKeys(): string[] {
  return [...records.keys()];
}

/** For tests. */
export function forgetReturnedProducts(): void {
  records.clear();
}
