import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  nearbyStores,
  type StoreBanner,
} from "../../apps/mobile/src/features/onboarding/stores.ts";
import { WA_STORES } from "../../apps/mobile/src/features/onboarding/storesWa.generated.ts";
import {
  parseStoresCsv,
  renderStoresModule,
  STORE_BANNERS,
  STORE_COLUMNS,
  STORES_CSV,
  STORES_MODULE,
  slug,
  storeId,
} from "./stores.ts";

const csv = readFileSync(STORES_CSV, "utf8");

describe("stores_wa.csv (WS06)", () => {
  const rows = parseStoresCsv(csv);

  it("has the columns the brief names and at least 60 Washington stores", () => {
    expect(csv.split("\n")[0]).toBe("banner,name,address,zip,lat,lng,kroger_location_id");
    expect(STORE_COLUMNS).toHaveLength(7);
    expect(rows.length).toBeGreaterThanOrEqual(60);
  });

  it("covers all six banners", () => {
    const banners = new Set(rows.map((r) => r.banner));
    for (const banner of STORE_BANNERS) expect(banners.has(banner), banner).toBe(true);
  });

  it("gives every store a distinct id, a 5 digit ZIP, and Washington coordinates", () => {
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    for (const row of rows) {
      expect(row.zip).toMatch(/^\d{5}$/);
      expect(row.lat).toBeGreaterThan(45.5);
      expect(row.lat).toBeLessThan(49.1);
      expect(row.lng).toBeLessThan(-116.9);
    }
  });

  it("lists at least three stores near ZIP 98019 (acceptance criterion 5)", () => {
    const { center, stores } = nearbyStores("98019", WA_STORES);
    expect(center?.exact).toBe(true);
    expect(stores.length).toBeGreaterThanOrEqual(3);
    expect(stores[0]?.zip).toBe("98019");
    // Costco and the Kroger banners are part of what a Duvall household sees.
    const banners = new Set(stores.map((s) => s.banner));
    expect(banners.has("costco")).toBe(true);
  });

  it("leaves kroger_location_id empty: WS07's live lookup is the source for those", () => {
    expect(rows.every((r) => r.krogerLocationId === null)).toBe(true);
  });

  it("builds ids from the Kroger location id when there is one, else the street", () => {
    expect(storeId("qfc", "98052", "15800 Redmond Way", "70100123")).toBe("70100123");
    expect(storeId("qfc", "98052", "15800 Redmond Way", null)).toBe("qfc-98052-15800-redmond-way");
    expect(slug("  425 Urban Plz, Ste 100 ")).toBe("425-urban-plz-ste-100");
  });

  it("rejects bad rows with the line number", () => {
    const header = "banner,name,address,zip,lat,lng,kroger_location_id\n";
    expect(() => parseStoresCsv(`${header}costco,X,1 Main St,9801,47.7,-122.1,`)).toThrow(
      /line 2.*zip/,
    );
    expect(() => parseStoresCsv(`${header}shop,X,1 Main St,98019,47.7,-122.1,`)).toThrow(/banner/);
    expect(() => parseStoresCsv(`${header}costco,X,1 Main St,98019,30.0,-122.1,`)).toThrow(
      /outside Washington/,
    );
    expect(() => parseStoresCsv(`${header}costco,X,1 Main St,98019,47.7,-122.1,123`)).toThrow(
      /8 digits/,
    );
    expect(() =>
      parseStoresCsv(
        `${header}costco,X,1 Main St,98019,47.7,-122.1,\ncostco,Y,1 Main St,98019,47.7,-122.1,`,
      ),
    ).toThrow(/duplicate/);
    expect(() => parseStoresCsv("a,b,c\n")).toThrow(/header/);
  });

  it("reads quoted fields", () => {
    const header = "banner,name,address,zip,lat,lng,kroger_location_id\n";
    const [row] = parseStoresCsv(
      `${header}costco,"Costco, Test","1 Main St, Ste 2",98019,47.7,-122.1,`,
    );
    expect(row?.name).toBe("Costco, Test");
    expect(row?.address).toBe("1 Main St, Ste 2");
  });
});

describe("storesWa.generated.ts", () => {
  it("matches the CSV (run `node supabase/seed/stores.ts` after editing it)", () => {
    const expected = renderStoresModule(parseStoresCsv(csv));
    expect(readFileSync(STORES_MODULE, "utf8")).toBe(expected);
  });

  it("holds the same stores as the CSV", () => {
    expect(WA_STORES.map((s) => s.id)).toEqual(parseStoresCsv(csv).map((r) => r.id));
  });

  it("uses the banner list the app uses", () => {
    const banners: StoreBanner[] = [...STORE_BANNERS];
    expect(banners).toEqual(["qfc", "fredmeyer", "safeway", "albertsons", "haggen", "costco"]);
  });
});
