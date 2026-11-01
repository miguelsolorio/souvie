// The stores Tier 3 shops at, as the person sees them (checkpoint 4, 2026-10-31). Retailer ids are
// what the database and the adapters use; banners are what the screen names. Albertsons and Haggen
// are banners of the `safeway` retailer and share one account and one set of terms, the way QFC
// and Fred Meyer are banners of `kroger`.
import { TIER3_RETAILER_IDS, type Tier3RetailerId } from "@mp/retailers";

export type Tier3StoreId = "safeway" | "albertsons" | "haggen" | "costco";

export interface Tier3Store {
  id: Tier3StoreId;
  retailer: Tier3RetailerId;
  /** The display name the consent copy fills `{store}` with. */
  name: string;
  /** Where the sign-in WebView opens. The person signs in through the site's own pages. */
  homeUrl: string;
}

export const TIER3_STORES: readonly Tier3Store[] = [
  { id: "safeway", retailer: "safeway", name: "Safeway", homeUrl: "https://www.safeway.com/" },
  {
    id: "albertsons",
    retailer: "safeway",
    name: "Albertsons",
    homeUrl: "https://www.albertsons.com/",
  },
  { id: "haggen", retailer: "safeway", name: "Haggen", homeUrl: "https://www.haggen.com/" },
  { id: "costco", retailer: "costco", name: "Costco", homeUrl: "https://www.costco.com/" },
];

/**
 * The registered domains whose cookies a retailer's session may keep (and their subdomains).
 * Everything else the site sets, third-party trackers included, is dropped before saving.
 */
export const RETAILER_SESSION_DOMAINS: Readonly<Record<Tier3RetailerId, readonly string[]>> = {
  safeway: ["safeway.com", "albertsons.com", "haggen.com"],
  costco: ["costco.com"],
};

export { TIER3_RETAILER_IDS };

export function tier3Store(id: Tier3StoreId): Tier3Store {
  const store = TIER3_STORES.find((s) => s.id === id);
  if (!store) throw new Error(`unknown Tier 3 store ${id}`);
  return store;
}

/** Banners of one retailer, in display order. */
export function storesOf(retailer: Tier3RetailerId): Tier3Store[] {
  return TIER3_STORES.filter((s) => s.retailer === retailer);
}

/** "Safeway, Albertsons and Haggen" for safeway; "Costco" for costco. */
export function retailerDisplayName(retailer: Tier3RetailerId): string {
  const names = storesOf(retailer).map((s) => s.name);
  if (names.length <= 1) return names[0] ?? retailer;
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** True when a cookie domain (".www.safeway.com", "safeway.com") belongs to one of `domains`. */
export function isAllowedCookieDomain(
  domain: string | undefined,
  domains: readonly string[],
): boolean {
  if (!domain) return false;
  const d = domain.trim().toLowerCase().replace(/^\.+/, "");
  return domains.some((allowed) => d === allowed || d.endsWith(`.${allowed}`));
}

/** Hosts the WebView may be on while signing in to or shopping at this retailer. */
export function allowedHosts(retailer: Tier3RetailerId): readonly string[] {
  return RETAILER_SESSION_DOMAINS[retailer];
}
