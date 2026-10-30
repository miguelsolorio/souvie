import { beforeEach, describe, expect, it } from "vitest";
import { RetailerTermsError } from "../errors.ts";
import type { Product } from "../types.ts";
import productsChickenThighs from "./__fixtures__/products-chicken-thighs.json";
import { T0 } from "./__fixtures__/replay.ts";
import { type KrogerProduct, mapProduct } from "./mappers.ts";
import {
  assertDisplayUnchanged,
  forgetReturnedProducts,
  formatPrice,
  isDisplayUnchanged,
  rememberReturned,
  returnedRecordCount,
  returnedRecordKeys,
} from "./terms.ts";

const RAW = productsChickenThighs.body.data as KrogerProduct[];
const AT = { now: T0 };

/** A product as the app receives it. `expiresAt` T0 means the response had no cache header. */
function product(index = 0, expiresAt = T0): Product {
  const raw = RAW[index];
  if (!raw) throw new Error("no fixture");
  return mapProduct(raw, expiresAt);
}

beforeEach(() => forgetReturnedProducts());

describe("assertDisplayUnchanged", () => {
  it("passes a received product and its rendered fields", () => {
    const p = product();
    rememberReturned(p, AT);
    expect(() =>
      assertDisplayUnchanged(
        p,
        {
          name: "Fixture Farms® Boneless Skinless Chicken Thighs Family Pack",
          price: "$5.99",
          promoPrice: "$4.49",
          imageUrl: "https://images.fixture.test/large/front/0009990001001",
        },
        AT,
      ),
    ).not.toThrow();
  });

  it("fails when the product's name was modified", () => {
    const p = product();
    rememberReturned(p, AT);
    let err: unknown;
    try {
      assertDisplayUnchanged({ ...p, name: p.name.toUpperCase() }, {}, AT);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RetailerTermsError);
    expect(err).toMatchObject({ field: "display", retailer: "kroger" });
  });

  it("fails when the rendered name is not the returned name verbatim", () => {
    const p = product();
    rememberReturned(p, AT);
    expect(isDisplayUnchanged(p, { name: `${p.name.slice(0, 20)}...` }, AT)).toBe(false);
    expect(isDisplayUnchanged(p, { name: p.name.replace("®", "") }, AT)).toBe(false);
  });

  it("does not allow trimming: whitespace Kroger sent is part of the name", () => {
    const p = product(3);
    rememberReturned(p, AT);
    expect(p.name.endsWith(" ")).toBe(true);
    expect(isDisplayUnchanged({ ...p, name: p.name.trim() }, {}, AT)).toBe(false);
    expect(isDisplayUnchanged(p, { name: p.name.trim() }, AT)).toBe(false);
  });

  it("fails on a changed price, promo, size, brand, or image", () => {
    const p = product();
    rememberReturned(p, AT);
    for (const change of [
      { price: 6 },
      { promoPrice: null },
      { size: "1 lb" },
      { brand: "Other" },
      { imageUrl: "https://images.fixture.test/cropped.jpg" },
    ]) {
      expect(isDisplayUnchanged({ ...p, ...change }, {}, AT)).toBe(false);
    }
    expect(isDisplayUnchanged(p, { price: "$6" }, AT)).toBe(false);
  });

  it("passes a copy that crossed a JSON boundary unchanged (Edge Function to app)", () => {
    const p = product();
    rememberReturned(p, AT);
    expect(isDisplayUnchanged(JSON.parse(JSON.stringify(p)) as Product, {}, AT)).toBe(true);
  });

  it("fails for a product nobody recorded", () => {
    expect(() => assertDisplayUnchanged(product(), {}, AT)).toThrow(RetailerTermsError);
  });

  it("accepts the same id at two stores with two prices", () => {
    const here = product();
    const there = { ...here, price: 6.49 };
    rememberReturned([here, there], AT);
    expect(isDisplayUnchanged(here, {}, AT)).toBe(true);
    expect(isDisplayUnchanged(there, {}, AT)).toBe(true);
  });
});

describe("what the guard keeps", () => {
  it("keeps hashes, not names, prices, or image URLs", () => {
    const p = product();
    rememberReturned(p, AT);
    const keys = returnedRecordKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^[0-9a-z]+\.[0-9a-z]+$/);
    for (const value of [p.name, p.brand, "5.99", "4.49", p.imageUrl]) {
      expect(keys.join(" ")).not.toContain(String(value));
    }
  });

  it("drops a no-cache-header result when the set is released (the fetch's own lifetime)", () => {
    const p = product(0, T0);
    const set = rememberReturned(p, AT);
    expect(isDisplayUnchanged(p, {}, { now: T0 + 60 * 60 * 1000 })).toBe(true);
    set.release();
    expect(isDisplayUnchanged(p, {}, AT)).toBe(false);
    expect(returnedRecordCount()).toBe(0);
  });

  it("expires a cacheable result at its cacheUntil, released or not", () => {
    const p = product(0, T0 + 3_600_000);
    rememberReturned(p, AT);
    expect(isDisplayUnchanged(p, {}, { now: T0 + 3_599_000 })).toBe(true);
    expect(isDisplayUnchanged(p, {}, { now: T0 + 3_600_000 })).toBe(false);
    expect(returnedRecordCount()).toBe(0);
  });

  it("keeps a record while any set that holds it is live", () => {
    const p = product();
    const first = rememberReturned(p, AT);
    const second = rememberReturned(p, AT);
    first.release();
    expect(isDisplayUnchanged(p, {}, AT)).toBe(true);
    second.release();
    second.release();
    expect(isDisplayUnchanged(p, {}, AT)).toBe(false);
  });

  it("bounds how many records it holds", () => {
    const base = product();
    const many = Array.from({ length: 2_100 }, (_, i) => ({ ...base, id: `id-${i}` }));
    rememberReturned(many, AT);
    expect(returnedRecordCount()).toBe(2_000);
    expect(isDisplayUnchanged(many[0] as Product, {}, AT)).toBe(false);
    expect(isDisplayUnchanged(many[2_099] as Product, {}, AT)).toBe(true);
  });
});

describe("formatPrice", () => {
  it("shows dollars and cents without rounding what Kroger sent", () => {
    expect(formatPrice(4.99)).toBe("$4.99");
    expect(formatPrice(5)).toBe("$5.00");
    expect(formatPrice(0.5)).toBe("$0.50");
    expect(formatPrice(1.234)).toBe("$1.234");
  });
});
