// Kroger terms guard. The developer terms require product data be displayed "exactly as it is
// returned": no changes to name, description, or price; images uncropped, with no overlays.
//
// How it works: every Product that comes out of the adapter (mapProduct) or arrives in the app
// from our Edge Function (rememberReturned) is recorded here with its display fields. Components
// that render Kroger data call assertDisplayUnchanged(product, rendered) with what they are about
// to show. A product whose fields drifted from any recorded copy, or a rendered string that is not
// the field verbatim, throws RetailerTermsError. Nothing is stored beyond this process's memory.
//
// Rendering rules the guard cannot see, which components must follow:
//   * Show the whole name. No numberOfLines truncation, no ellipsis, no case transforms.
//   * Images use resizeMode "contain" and nothing is drawn on top of them.
//   * Fulfillment flags mean "approved for", not "in stock". Label them that way.
//   * No other retailer's price on the same screen.
import { RetailerTermsError } from "../errors.ts";
import type { Product } from "../types.ts";

/** The fields Kroger's terms protect, in the order we compare them. */
export const DISPLAY_FIELDS = [
  "name",
  "brand",
  "size",
  "price",
  "promoPrice",
  "imageUrl",
] as const satisfies readonly (keyof Product)[];

type DisplayField = (typeof DISPLAY_FIELDS)[number];
type DisplaySnapshot = Pick<Product, DisplayField>;

/** Copies kept per product id. Several stores can return the same id at different prices. */
const PER_ID = 8;
/** Product ids remembered at most; the least recently seen go first. */
const MAX_IDS = 5_000;

const returned = new Map<string, DisplaySnapshot[]>();

function snapshot(product: Product): DisplaySnapshot {
  return {
    name: product.name,
    brand: product.brand,
    size: product.size,
    price: product.price,
    promoPrice: product.promoPrice,
    imageUrl: product.imageUrl,
  };
}

function same(a: DisplaySnapshot, b: DisplaySnapshot): boolean {
  return DISPLAY_FIELDS.every((field) => Object.is(a[field], b[field]));
}

/**
 * Records a product exactly as the retailer returned it. The adapter calls this for every product
 * it maps; the app calls it for products it receives from the retailer-oauth Edge Function.
 */
export function rememberReturned(product: Product): void {
  const copy = snapshot(product);
  const list = returned.get(product.id) ?? [];
  returned.delete(product.id);
  if (!list.some((s) => same(s, copy))) {
    list.push(copy);
    if (list.length > PER_ID) list.shift();
  }
  returned.set(product.id, list);
  while (returned.size > MAX_IDS) {
    const oldest = returned.keys().next().value;
    if (oldest === undefined) break;
    returned.delete(oldest);
  }
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
 * Throws RetailerTermsError unless `product` matches a copy the retailer returned and every
 * rendered string is that field verbatim (prices through formatPrice). Call it in render.
 */
export function assertDisplayUnchanged(product: Product, rendered: RenderedDisplay = {}): void {
  const copies = returned.get(product.id);
  if (!copies || copies.length === 0) {
    fail("id", `Product ${product.id} was not returned by the retailer in this session`);
  }
  const current = snapshot(product);
  if (!copies.some((copy) => same(copy, current))) {
    const nearest = copies[copies.length - 1] as DisplaySnapshot;
    const field = DISPLAY_FIELDS.find((f) => !Object.is(nearest[f], current[f])) ?? "name";
    fail(field, `Product ${product.id} ${field} differs from what the retailer returned`);
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
export function isDisplayUnchanged(product: Product, rendered: RenderedDisplay = {}): boolean {
  try {
    assertDisplayUnchanged(product, rendered);
    return true;
  } catch {
    return false;
  }
}

/** For tests. */
export function forgetReturnedProducts(): void {
  returned.clear();
}
