// Generates apps/mobile/src/features/onboarding/storesWa.generated.ts from stores_wa.csv (WS06).
//
//   node supabase/seed/stores.ts            rewrite the module
//   node supabase/seed/stores.ts --check    exit 1 when the module is stale
//
// stores_wa.csv is a stopgap list of Washington stores for the onboarding "stores" step. The app
// bundles it as a module (no table, no query), so the step works before a person has a household.
// WS07's live Kroger Locations lookup replaces the QFC and Fred Meyer rows once it is reachable
// (see apps/mobile/src/features/onboarding/stores.ts for how the two sources are combined).
//
// Plain, erasable TypeScript: Node runs this file directly, and the tests import it.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const STORES_CSV = join(HERE, "stores_wa.csv");
export const STORES_MODULE = join(
  HERE,
  "..",
  "..",
  "apps",
  "mobile",
  "src",
  "features",
  "onboarding",
  "storesWa.generated.ts",
);

export const STORE_BANNERS = [
  "qfc",
  "fredmeyer",
  "safeway",
  "albertsons",
  "haggen",
  "costco",
] as const;
export type StoreBanner = (typeof STORE_BANNERS)[number];

export const STORE_COLUMNS = [
  "banner",
  "name",
  "address",
  "zip",
  "lat",
  "lng",
  "kroger_location_id",
] as const;

export interface StoreRow {
  /** The Kroger locationId when known, else <banner>-<zip>-<street slug>. Stable across builds. */
  id: string;
  banner: StoreBanner;
  name: string;
  address: string;
  zip: string;
  lat: number;
  lng: number;
  krogerLocationId: string | null;
}

/** Splits one CSV line, honoring double quotes. The file has no embedded newlines. */
function splitLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(field);
      field = "";
    } else field += ch;
  }
  out.push(field);
  return out;
}

export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function storeId(
  banner: string,
  zip: string,
  address: string,
  krogerLocationId: string | null,
): string {
  return krogerLocationId ? krogerLocationId : `${banner}-${zip}-${slug(address)}`;
}

/** Parses stores_wa.csv. Throws on a bad header, a bad row, or a duplicate id. */
export function parseStoresCsv(text: string): StoreRow[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  const header = splitLine(lines[0] ?? "");
  if (header.join(",") !== STORE_COLUMNS.join(",")) {
    throw new Error(
      `stores_wa.csv header must be ${STORE_COLUMNS.join(",")}, got ${header.join(",")}`,
    );
  }
  const seen = new Set<string>();
  return lines.slice(1).map((line, index) => {
    const row = splitLine(line);
    const where = `stores_wa.csv line ${index + 2}`;
    if (row.length !== STORE_COLUMNS.length)
      throw new Error(`${where}: expected ${STORE_COLUMNS.length} columns`);
    const [banner, name, address, zip, lat, lng, kroger] = row.map((cell) => cell.trim()) as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (!(STORE_BANNERS as readonly string[]).includes(banner))
      throw new Error(`${where}: unknown banner ${banner}`);
    if (!name || !address) throw new Error(`${where}: name and address are required`);
    if (!/^\d{5}$/.test(zip)) throw new Error(`${where}: zip must be 5 digits`);
    const latitude = Number(lat);
    const longitude = Number(lng);
    // Washington sits between 45.5 and 49.0 degrees north and 116.9 and 124.8 west.
    if (!(latitude >= 45.5 && latitude <= 49.1))
      throw new Error(`${where}: lat is outside Washington`);
    if (!(longitude >= -124.9 && longitude <= -116.9))
      throw new Error(`${where}: lng is outside Washington`);
    if (kroger && !/^\d{8}$/.test(kroger))
      throw new Error(`${where}: kroger_location_id must be 8 digits`);
    const id = storeId(banner, zip, address, kroger || null);
    if (seen.has(id)) throw new Error(`${where}: duplicate store ${id}`);
    seen.add(id);
    return {
      id,
      banner: banner as StoreBanner,
      name,
      address,
      zip,
      lat: latitude,
      lng: longitude,
      krogerLocationId: kroger || null,
    };
  });
}

/** The text of storesWa.generated.ts for these rows, laid out the way Biome formats it. */
export function renderStoresModule(rows: readonly StoreRow[]): string {
  const body = rows
    .map((r) =>
      [
        "  {",
        `    id: ${JSON.stringify(r.id)},`,
        `    banner: ${JSON.stringify(r.banner)},`,
        `    name: ${JSON.stringify(r.name)},`,
        `    address: ${JSON.stringify(r.address)},`,
        `    zip: ${JSON.stringify(r.zip)},`,
        `    lat: ${r.lat},`,
        `    lng: ${r.lng},`,
        `    krogerLocationId: ${JSON.stringify(r.krogerLocationId)},`,
        "  },",
      ].join("\n"),
    )
    .join("\n");
  return `// Generated by \`node supabase/seed/stores.ts\` from supabase/seed/stores_wa.csv. Do not edit.
// A stopgap list of Washington stores for the onboarding stores step (WS06). Coordinates are
// approximate (a neighborhood or city centre): good for sorting by distance, nothing finer.
import type { WaStore } from "./stores";

export const WA_STORES: readonly WaStore[] = [
${body}
];
`;
}

function main(argv: string[]): number {
  const rows = parseStoresCsv(readFileSync(STORES_CSV, "utf8"));
  const next = renderStoresModule(rows);
  let current = "";
  try {
    current = readFileSync(STORES_MODULE, "utf8");
  } catch {
    current = "";
  }
  if (argv.includes("--check")) {
    if (current !== next) {
      console.error("storesWa.generated.ts is stale. Run: node supabase/seed/stores.ts");
      return 1;
    }
    console.log(`storesWa.generated.ts is current (${rows.length} stores)`);
    return 0;
  }
  writeFileSync(STORES_MODULE, next);
  console.log(`wrote ${rows.length} stores to ${STORES_MODULE}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
