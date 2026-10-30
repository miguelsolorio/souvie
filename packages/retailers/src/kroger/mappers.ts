// Kroger API shapes to the shared contract. Display fields are copied, never edited: no trimming,
// no case changes, no rounding (Kroger terms; terms.ts checks it). Shapes follow the live API as
// observed on 2026-10-30 (fulfillment keys are camelCase: inStore, shipToHome).
import type { Product, StockLevel, Store } from "../types.ts";

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

export type AllergenLevel = "contains" | "may_contain" | "undeclared" | "absent";

/**
 * Kroger's `levelOfContainmentName`. Seen live on QFC products (2026-10-30): "Contains",
 * "May contain", "Free from", "Not intentionally nor inherently included", and "Undeclared".
 * "Free from" and "Not intentionally..." mean the product does not contain the allergen.
 * "Undeclared" means the maker did not say either way, so it stays in the safety list. Any level
 * we do not recognize counts as "contains": allergy safety must fail closed
 * (docs/05-security-privacy.md §Allergen safety).
 */
export function allergenLevel(level: string | undefined): AllergenLevel {
  const text = level?.trim() ?? "";
  if (/free\s*from|does\s*not\s*contain|^not\s+(intentionally|inherently|contain)/i.test(text)) {
    return "absent";
  }
  if (/^may\s*contain/i.test(text)) return "may_contain";
  if (/^undeclared$|^not\s+declared$/i.test(text)) return "undeclared";
  return "contains";
}

export interface MappedAllergens {
  /** Contains, may contain, or undeclared: the list safety checks read. */
  allergens: string[];
  /** The subset declared only as "may contain". */
  mayContain: string[];
  /** The subset whose presence the maker did not declare ("Undeclared"). */
  undeclared: string[];
}

/** Strongest first. An allergen listed twice keeps the strongest level it was given. */
const STRENGTH: Record<Exclude<AllergenLevel, "absent">, number> = {
  contains: 3,
  may_contain: 2,
  undeclared: 1,
};

/** Allergen names as Kroger gives them, split by level. */
export function mapAllergens(raw: KrogerProduct["allergens"]): MappedAllergens {
  const levels = new Map<string, Exclude<AllergenLevel, "absent">>();
  for (const a of raw ?? []) {
    if (!a.name) continue;
    const level = allergenLevel(a.levelOfContainmentName);
    if (level === "absent") continue;
    const seen = levels.get(a.name);
    if (!seen || STRENGTH[level] > STRENGTH[seen]) levels.set(a.name, level);
  }
  const named = (wanted: AllergenLevel) =>
    [...levels].filter(([, level]) => level === wanted).map(([name]) => name);
  return {
    allergens: [...levels.keys()],
    mayContain: named("may_contain"),
    undeclared: named("undeclared"),
  };
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
 * frozen, so nothing downstream can edit a display field. Nothing is recorded here: the app
 * records what it receives with terms.ts, for as long as it shows it.
 */
export function mapProduct(raw: KrogerProduct, expiresAt: number): Product {
  // The public tier returns one item per product for a location (observed); use the first.
  const item = raw.items?.[0];
  const allergens = mapAllergens(raw.allergens);
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
    allergens: Object.freeze(allergens.allergens) as string[],
    mayContain: Object.freeze(allergens.mayContain) as string[],
    undeclared: Object.freeze(allergens.undeclared) as string[],
    imageUrl: pickImageUrl(raw.images),
    cacheUntil: new Date(expiresAt).toISOString(),
  };
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
