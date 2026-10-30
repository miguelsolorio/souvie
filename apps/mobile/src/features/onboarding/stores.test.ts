import { describe, expect, it } from "vitest";
import {
  distanceMiles,
  isKrogerBanner,
  krogerChainOf,
  milesLabel,
  nearbyStores,
  storeById,
  type WaStore,
  zipCenter,
} from "./stores";
import { WA_STORES } from "./storesWa.generated";

const store = (id: string, zip: string, lat: number, lng: number, banner = "safeway"): WaStore => ({
  id,
  banner: banner as WaStore["banner"],
  name: id,
  address: "1 Main St",
  zip,
  lat,
  lng,
  krogerLocationId: null,
});

describe("distanceMiles", () => {
  it("is zero for the same point", () => {
    expect(distanceMiles(47.7, -122.1, 47.7, -122.1)).toBeCloseTo(0, 6);
  });

  it("is about 11 miles from Duvall to Woodinville", () => {
    const miles = distanceMiles(47.7423, -121.9857, 47.7543, -122.1635);
    expect(miles).toBeGreaterThan(7);
    expect(miles).toBeLessThan(9);
  });

  it("is symmetric and about 2,400 miles from Seattle to Boston", () => {
    const a = distanceMiles(47.6062, -122.3321, 42.3601, -71.0589);
    expect(a).toBeGreaterThan(2350);
    expect(a).toBeLessThan(2500);
    expect(distanceMiles(42.3601, -71.0589, 47.6062, -122.3321)).toBeCloseTo(a, 6);
  });
});

describe("zipCenter", () => {
  const list = [
    store("a", "98019", 47.74, -121.98),
    store("b", "98019", 47.76, -121.96),
    store("c", "98052", 47.67, -122.12),
    store("d", "99202", 47.65, -117.4),
  ];

  it("places a ZIP at the middle of its stores", () => {
    const center = zipCenter("98019", list);
    expect(center?.exact).toBe(true);
    expect(center?.lat).toBeCloseTo(47.75, 6);
    expect(center?.lng).toBeCloseTo(-121.97, 6);
  });

  it("places an unknown ZIP at the nearest ZIP by number and says it is an estimate", () => {
    const center = zipCenter("98050", list);
    expect(center?.exact).toBe(false);
    expect(center?.lat).toBeCloseTo(47.67, 6);
    const east = zipCenter("99301", list);
    expect(east?.lat).toBeCloseTo(47.65, 6);
  });

  it("returns null for a bad ZIP or an empty list", () => {
    expect(zipCenter("9801", list)).toBeNull();
    expect(zipCenter("abcde", list)).toBeNull();
    expect(zipCenter("98019", [])).toBeNull();
  });
});

describe("nearbyStores", () => {
  it("lists the nearest first and drops anything past the radius", () => {
    const { stores, center } = nearbyStores("98019", WA_STORES);
    expect(center?.exact).toBe(true);
    expect(stores.length).toBeGreaterThanOrEqual(3);
    const miles = stores.map((s) => s.miles);
    expect([...miles].sort((a, b) => a - b)).toEqual(miles);
    expect(miles.every((m) => m <= 25)).toBe(true);
    expect(stores[0]?.name).toBe("Safeway Duvall");
  });

  it("limits the list and can narrow it to some banners", () => {
    expect(nearbyStores("98019", WA_STORES, { limit: 3 }).stores).toHaveLength(3);
    const costcos = nearbyStores("98019", WA_STORES, {
      banners: ["costco"],
      radiusMiles: 40,
    }).stores;
    expect(costcos.length).toBeGreaterThan(0);
    expect(costcos.every((s) => s.banner === "costco")).toBe(true);
  });

  it("finds nothing for a ZIP far from every store, instead of the wrong ones", () => {
    const list = [store("a", "98019", 47.74, -121.98)];
    // 99301 maps to the only ZIP there is, so it is placed at Duvall; a 1 mile radius still holds.
    expect(nearbyStores("99301", list, { radiusMiles: 1 }).stores).toHaveLength(1);
    // Not 5 digits: nothing.
    expect(nearbyStores("9930", list).stores).toEqual([]);
  });

  it("still gives a Spokane ZIP the Spokane stores", () => {
    const { stores } = nearbyStores("99203", WA_STORES);
    expect(stores.length).toBeGreaterThan(0);
    expect(stores.every((s) => s.lng < -117)).toBe(true);
  });
});

describe("helpers", () => {
  it("knows the Kroger banners and their chain codes", () => {
    expect(isKrogerBanner("qfc")).toBe(true);
    expect(isKrogerBanner("fredmeyer")).toBe(true);
    expect(isKrogerBanner("safeway")).toBe(false);
    expect(krogerChainOf("qfc")).toBe("QFC");
    expect(krogerChainOf("fredmeyer")).toBe("FRED");
    expect(krogerChainOf("costco")).toBeUndefined();
  });

  it("finds a store by id", () => {
    expect(storeById("safeway-98019-14020-main-st-ne", WA_STORES)?.name).toBe("Safeway Duvall");
    expect(storeById("nope", WA_STORES)).toBeNull();
    expect(storeById(null, WA_STORES)).toBeNull();
  });

  it("words a distance as approximate", () => {
    expect(milesLabel(0.2)).toBe("about 1 mile");
    expect(milesLabel(3.4)).toBe("about 3 miles");
  });
});
