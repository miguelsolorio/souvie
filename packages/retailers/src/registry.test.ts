import { afterEach, describe, expect, it } from "vitest";
import { RetailerError, RetailerNotSupportedError } from "./errors.ts";
import { MockRetailer } from "./mock/MockRetailer.ts";
import { assertRefInCandidates, pickCandidate, productRef } from "./refs.ts";
import {
  AdapterRegistry,
  defaultRegistry,
  getAdapter,
  isAdapterAvailable,
  listAdapters,
  registerAdapter,
} from "./registry.ts";

afterEach(() => defaultRegistry.clear());

describe("registry", () => {
  it("lists every retailer with its documented capabilities before anything registers", () => {
    const listing = new AdapterRegistry().listAdapters();
    expect(listing.map((l) => l.id)).toEqual(["kroger", "safeway", "costco"]);
    expect(listing.every((l) => !l.available)).toBe(true);
    expect(listing[0]?.capabilities.cartRead).toBe("none");
    expect(listing[1]?.capabilities.checkout).toBe("browser");
    expect(listing[2]?.capabilities.checkout).toBe("browser");
  });

  it("hands out a registered adapter and reports it available", () => {
    const mock = new MockRetailer();
    registerAdapter(mock);
    expect(isAdapterAvailable("kroger")).toBe(true);
    expect(getAdapter("kroger")).toBe(mock);
    expect(listAdapters()[0]).toEqual({
      id: "kroger",
      capabilities: mock.capabilities,
      available: true,
    });
  });

  it("throws RetailerNotSupportedError for a missing or disabled adapter", () => {
    expect(() => getAdapter("costco")).toThrow(RetailerNotSupportedError);
    registerAdapter(new MockRetailer({ id: "costco" }));
    defaultRegistry.setEnabled("costco", false);
    expect(isAdapterAvailable("costco")).toBe(false);
    expect(() => getAdapter("costco")).toThrow(RetailerNotSupportedError);
    defaultRegistry.setEnabled("costco", true);
    expect(getAdapter("costco").id).toBe("costco");
  });
});

describe("ProductRef", () => {
  it("is minted only from returned candidates and checked against them", async () => {
    const mock = new MockRetailer();
    const [store] = await mock.findStores("98019");
    if (!store) throw new Error("no store");
    const candidates = await mock.searchProducts("butter", store);
    const second = candidates[1];
    if (!second) throw new Error("need two candidates");
    const ref = pickCandidate(store, candidates, 1);
    expect(ref).toEqual(productRef(store, second));
    expect(Object.isFrozen(ref)).toBe(true);
    expect(assertRefInCandidates(ref, candidates)).toBe(second);

    expect(() => pickCandidate(store, candidates, candidates.length)).toThrow(RetailerError);
    expect(() => pickCandidate(store, candidates, 0.5)).toThrow(RetailerError);
    expect(() => assertRefInCandidates(ref, candidates.slice(0, 1))).toThrow(RetailerError);
  });
});
