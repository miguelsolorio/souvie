// Nearby stores for the onboarding stores step (WS06). Pure functions over the bundled Washington
// list (storesWa.generated.ts, made from supabase/seed/stores_wa.csv). No React Native imports, so
// Vitest runs it.
//
// How a ZIP becomes a place: the list has no ZIP table, so a ZIP is placed at the middle of the
// stores that carry it. A ZIP with no store in the list is placed at the nearest ZIP by number,
// which is roughly right in Washington because ZIPs run in regional blocks, and is reported as an
// estimate. Distances are approximate: store coordinates are neighborhood level.

export type StoreBanner = "qfc" | "fredmeyer" | "safeway" | "albertsons" | "haggen" | "costco";

export interface WaStore {
  /** The Kroger locationId when known, else <banner>-<zip>-<street slug>. */
  id: string;
  banner: StoreBanner;
  name: string;
  address: string;
  zip: string;
  lat: number;
  lng: number;
  krogerLocationId: string | null;
}

export interface NearbyStore extends WaStore {
  /** Straight-line miles from the ZIP. */
  miles: number;
}

export const BANNER_LABEL: Record<StoreBanner, string> = {
  qfc: "QFC",
  fredmeyer: "Fred Meyer",
  safeway: "Safeway",
  albertsons: "Albertsons",
  haggen: "Haggen",
  costco: "Costco",
};

/** Banners whose stores the live Kroger lookup covers. */
export const KROGER_BANNERS: readonly StoreBanner[] = ["qfc", "fredmeyer"];

export function isKrogerBanner(banner: StoreBanner): boolean {
  return KROGER_BANNERS.includes(banner);
}

/** The Kroger chain code (as the Locations API spells it) for a Kroger banner. */
export function krogerChainOf(banner: StoreBanner): string | undefined {
  if (banner === "qfc") return "QFC";
  if (banner === "fredmeyer") return "FRED";
  return undefined;
}

/** What `preferences.primary_store_id` holds when the person's store is not on any list. */
export const OTHER_STORE_ID = "other";

const EARTH_RADIUS_MILES = 3958.8;

export function distanceMiles(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface ZipCenter {
  lat: number;
  lng: number;
  /** True when a store in the list carries this ZIP; false when it was placed by the nearest ZIP. */
  exact: boolean;
}

function meanOf(stores: readonly WaStore[]): { lat: number; lng: number } {
  const lat = stores.reduce((sum, s) => sum + s.lat, 0) / stores.length;
  const lng = stores.reduce((sum, s) => sum + s.lng, 0) / stores.length;
  return { lat, lng };
}

export function zipCenter(zip: string, stores: readonly WaStore[]): ZipCenter | null {
  if (!/^\d{5}$/.test(zip) || stores.length === 0) return null;
  const same = stores.filter((s) => s.zip === zip);
  if (same.length > 0) return { ...meanOf(same), exact: true };

  const target = Number(zip);
  let best: WaStore[] = [];
  let bestGap = Number.POSITIVE_INFINITY;
  for (const store of stores) {
    const gap = Math.abs(Number(store.zip) - target);
    if (gap < bestGap) {
      bestGap = gap;
      best = [store];
    } else if (gap === bestGap) {
      best.push(store);
    }
  }
  return { ...meanOf(best), exact: false };
}

export interface NearbyOptions {
  /** Default 25 miles. */
  radiusMiles?: number;
  /** Default 12. */
  limit?: number;
  /** Only these banners. Default all. */
  banners?: readonly StoreBanner[];
}

export interface NearbyResult {
  center: ZipCenter | null;
  stores: NearbyStore[];
}

/** Stores within the radius of a ZIP, nearest first. Empty for a ZIP that is not 5 digits. */
export function nearbyStores(
  zip: string,
  stores: readonly WaStore[],
  options: NearbyOptions = {},
): NearbyResult {
  const center = zipCenter(zip, stores);
  if (!center) return { center: null, stores: [] };
  const radius = options.radiusMiles ?? 25;
  const limit = options.limit ?? 12;
  const found = stores
    .filter((s) => !options.banners || options.banners.includes(s.banner))
    .map((s) => ({ ...s, miles: distanceMiles(center.lat, center.lng, s.lat, s.lng) }))
    .filter((s) => s.miles <= radius)
    .sort((a, b) => a.miles - b.miles || a.name.localeCompare(b.name));
  return { center, stores: found.slice(0, limit) };
}

export function storeById(
  id: string | null | undefined,
  stores: readonly WaStore[],
): WaStore | null {
  if (!id) return null;
  return stores.find((s) => s.id === id) ?? null;
}

/** "about 3 miles" for a distance that is only approximate. */
export function milesLabel(miles: number): string {
  const rounded = Math.max(1, Math.round(miles));
  return `about ${rounded} ${rounded === 1 ? "mile" : "miles"}`;
}
