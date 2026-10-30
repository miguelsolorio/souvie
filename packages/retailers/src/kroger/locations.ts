// Kroger Locations API: stores near a ZIP, one store by id, and the chain list. Client
// credentials only. Location data is shown exactly as returned, like product data.
import type { FindStoresOptions, Store } from "../types.ts";
import type { KrogerClient } from "./client.ts";
import { type KrogerList, type KrogerLocation, type KrogerOne, mapStore } from "./mappers.ts";

/** The Kroger chains this adapter serves (QFC and Fred Meyer, docs/00-overview.md). */
export const SUPPORTED_CHAINS: ReadonlySet<string> = new Set(["QFC", "FRED"]);

export const DEFAULT_RADIUS_MILES = 10;
/** filter.radiusInMiles is 1 to 100. */
export const MAX_RADIUS_MILES = 100;
/** filter.limit is 1 to 200; 50 is plenty to fill a picker after filtering by chain. */
export const STORE_SEARCH_LIMIT = 50;

export function isZip(value: string): boolean {
  return /^\d{5}$/.test(value);
}

/**
 * QFC and Fred Meyer stores near `zip`, nearest first (Kroger's order). One Locations call; the
 * chain filter runs on our side so it does not cost a call per chain.
 */
export async function findStores(
  client: KrogerClient,
  zip: string,
  opts: FindStoresOptions = {},
): Promise<Store[]> {
  const trimmed = zip.trim();
  if (!isZip(trimmed)) return [];
  const radius = Math.max(
    1,
    Math.min(MAX_RADIUS_MILES, Math.trunc(opts.radiusMiles ?? DEFAULT_RADIUS_MILES)),
  );
  const params = new URLSearchParams();
  params.set("filter.zipCode.near", trimmed);
  params.set("filter.radiusInMiles", String(radius));
  params.set("filter.limit", String(STORE_SEARCH_LIMIT));
  const res = await client.catalog<KrogerList<KrogerLocation>>("locations", "/locations", params);
  return (res.body.data ?? [])
    .filter((loc) => SUPPORTED_CHAINS.has((loc.chain ?? "").toUpperCase()))
    .map(mapStore);
}

/** One store by its 8-character locationId. Null when Kroger has no such store. */
export async function getStore(client: KrogerClient, locationId: string): Promise<Store | null> {
  if (!/^[A-Za-z0-9]{8}$/.test(locationId)) return null;
  try {
    const res = await client.catalog<KrogerOne<KrogerLocation>>(
      "locations",
      `/locations/${encodeURIComponent(locationId)}`,
    );
    return res.body.data ? mapStore(res.body.data) : null;
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
}

export interface KrogerChain {
  name: string;
  friendlyBannerName?: string;
  domain?: string;
}

/** Chain names and banner names as Kroger lists them. */
export async function listChains(client: KrogerClient): Promise<KrogerChain[]> {
  const res = await client.catalog<KrogerList<KrogerChain>>("chains", "/chains");
  return res.body.data ?? [];
}
