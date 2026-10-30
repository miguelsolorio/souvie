// Kroger API shapes to the shared contract. Display fields are copied, never edited: no trimming,
// no case changes, no rounding (Kroger terms; terms.ts checks it). Shapes follow the live API as
// observed on 2026-10-30 (fulfillment keys are camelCase: inStore, shipToHome).
import type { Product, StockLevel, Store } from "../types.ts";
import { rememberReturned } from "./terms.ts";

export interface KrogerPrice {
  regular?: number;
  promo?: number;
  regularPerUnitEstimate?: number;
  promoPerUnitEstimate?: number;
}

export interface KrogerItem {
  itemId?: string;
  size?: string;
  soldBy?: string;
  price?: KrogerPrice;
  nationalPrice?: KrogerPrice;
  inventory?: { stockLevel?: string };
  fulfillment?: {
    inStore?: boolean;
    curbside?: boolean;
    delivery?: boolean;
    shipToHome?: boolean;
  };
}

export interface KrogerImage {
  perspective?: string;
  featured?: boolean;
  sizes?: { size?: string; url?: string }[];
}

export interface KrogerProduct {
  productId: string;
  upc?: string;
  description?: string;
  brand?: string;
  categories?: string[];
  allergens?: { name?: string; levelOfContainmentName?: string }[];
  images?: KrogerImage[];
  items?: KrogerItem[];
}

export interface KrogerLocation {
  locationId: string;
  chain?: string;
  name?: string;
  address?: {
    addressLine1?: string;
    addressLine2?: string;
    city?: string;
    state?: string;
    zipCode?: string;
  };
  geolocation?: { latitude?: number; longitude?: number };
}

export interface KrogerList<T> {
  data?: T[];
  meta?: { pagination?: { start?: number; limit?: number; total?: number } };
}

export interface KrogerOne<T> {
  data?: T;
}

const STOCK: ReadonlySet<string> = new Set(["HIGH", "LOW", "TEMPORARILY_OUT_OF_STOCK"]);

export function mapStockLevel(value: string | undefined): StockLevel {
  return value && STOCK.has(value) ? (value as StockLevel) : "UNKNOWN";
}

/** Levels that mean the product does not contain the allergen. Everything else counts. */
const ABSENT_LEVEL = /free\s*from|does\s*not\s*contain|^not\s*contain/i;

/**
 * Allergen names the product contains or may contain, as Kroger names them. Allergy safety is a
 * deterministic check downstream (docs/05-security-privacy.md §Allergen safety), so "may contain"
 * is kept: the conservative reading.
 */
export function mapAllergens(raw: KrogerProduct["allergens"]): string[] {
  const out: string[] = [];
  for (const a of raw ?? []) {
    if (!a.name) continue;
    if (a.levelOfContainmentName && ABSENT_LEVEL.test(a.levelOfContainmentName)) continue;
    if (!out.includes(a.name)) out.push(a.name);
  }
  return out;
}

const IMAGE_SIZE_PREFERENCE = ["large", "xlarge", "medium", "small", "thumbnail"];

/** The featured image (front when none is marked), at the first size Kroger offers in our order. */
export function pickImageUrl(images: KrogerImage[] | undefined): string | null {
  if (!images || images.length === 0) return null;
  const image =
    images.find((i) => i.featured) ?? images.find((i) => i.perspective === "front") ?? images[0];
  const sizes = image?.sizes ?? [];
  for (const wanted of IMAGE_SIZE_PREFERENCE) {
    const hit = sizes.find((s) => s.size === wanted && s.url);
    if (hit?.url) return hit.url;
  }
  return sizes.find((s) => s.url)?.url ?? null;
}

/** Kroger sends promo 0 when there is no promotion. Any other value is passed through as is. */
function promoOf(price: KrogerPrice | undefined): number | null {
  const promo = price?.promo;
  return typeof promo === "number" && promo > 0 ? promo : null;
}

function regularOf(price: KrogerPrice | undefined): number | null {
  const regular = price?.regular;
  return typeof regular === "number" && regular > 0 ? regular : null;
}

function soldByOf(value: string | undefined): Product["soldBy"] {
  if (value === "UNIT" || value === "WEIGHT") return value;
  return null;
}

/**
 * Maps one Kroger product. `expiresAt` comes from the response's cache headers. The result is
 * frozen and recorded with terms.ts so the UI can prove it renders it unchanged.
 */
export function mapProduct(raw: KrogerProduct, expiresAt: number): Product {
  // The public tier returns one item per product for a location (observed); use the first.
  const item = raw.items?.[0];
  const product: Product = {
    id: raw.productId,
    upc: raw.upc ?? null,
    name: raw.description ?? "",
    brand: raw.brand ?? null,
    size: item?.size ?? null,
    price: regularOf(item?.price),
    promoPrice: promoOf(item?.price),
    soldBy: soldByOf(item?.soldBy),
    stockLevel: mapStockLevel(item?.inventory?.stockLevel),
    fulfillment: Object.freeze({
      instore: item?.fulfillment?.inStore === true,
      curbside: item?.fulfillment?.curbside === true,
      delivery: item?.fulfillment?.delivery === true,
      shiptohome: item?.fulfillment?.shipToHome === true,
    }),
    allergens: Object.freeze(mapAllergens(raw.allergens)) as string[],
    imageUrl: pickImageUrl(raw.images),
    cacheUntil: new Date(expiresAt).toISOString(),
  };
  rememberReturned(product);
  return Object.freeze(product);
}

/** Address parts joined in their own order, each exactly as returned. */
function addressOf(address: KrogerLocation["address"]): string {
  return [address?.addressLine1, address?.addressLine2, address?.city, address?.state]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(", ");
}

export function mapStore(raw: KrogerLocation): Store {
  return Object.freeze({
    id: raw.locationId,
    retailer: "kroger" as const,
    chain: raw.chain ?? "",
    name: raw.name ?? "",
    address: addressOf(raw.address),
    zip: raw.address?.zipCode ?? "",
    lat: raw.geolocation?.latitude ?? 0,
    lng: raw.geolocation?.longitude ?? 0,
  });
}
