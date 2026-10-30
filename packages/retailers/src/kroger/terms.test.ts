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
} from "./terms.ts";

const RAW = productsChickenThighs.body.data as KrogerProduct[];

function returnedProduct(index = 0): Product {
  const raw = RAW[index];
  if (!raw) throw new Error("no fixture");
  return mapProduct(raw, T0);
}

beforeEach(() => forgetReturnedProducts());

describe("assertDisplayUnchanged", () => {
  it("passes a product exactly as the adapter returned it, and its rendered fields", () => {
    const product = returnedProduct();
    expect(() =>
      assertDisplayUnchanged(product, {
        name: "Fixture Farms® Boneless Skinless Chicken Thighs Family Pack",
        price: "$5.99",
        promoPrice: "$4.49",
        imageUrl: "https://images.fixture.test/large/front/0009990001001",
      }),
    ).not.toThrow();
  });

  it("fails when the product's name was modified", () => {
    const product = returnedProduct();
    const modified = { ...product, name: product.name.toUpperCase() };
    let err: unknown;
    try {
      assertDisplayUnchanged(modified);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RetailerTermsError);
    expect(err).toMatchObject({ field: "name", retailer: "kroger" });
  });

  it("fails when the rendered name is not the returned name verbatim", () => {
    const product = returnedProduct();
    expect(isDisplayUnchanged(product, { name: `${product.name.slice(0, 20)}...` })).toBe(false);
    expect(isDisplayUnchanged(product, { name: product.name.replace("®", "") })).toBe(false);
  });

  it("does not allow trimming: whitespace Kroger sent is part of the name", () => {
    const product = returnedProduct(3);
    expect(product.name.endsWith(" ")).toBe(true);
    expect(isDisplayUnchanged({ ...product, name: product.name.trim() })).toBe(false);
    expect(isDisplayUnchanged(product, { name: product.name.trim() })).toBe(false);
  });

  it("fails on a changed price, promo, size, brand, or image", () => {
    const product = returnedProduct();
    for (const change of [
      { price: 6 },
      { promoPrice: null },
      { size: "1 lb" },
      { brand: "Other" },
      { imageUrl: "https://images.fixture.test/cropped.jpg" },
    ]) {
      expect(isDisplayUnchanged({ ...product, ...change })).toBe(false);
    }
    expect(isDisplayUnchanged(product, { price: "$6" })).toBe(false);
  });

  it("passes a copy that crossed a JSON boundary unchanged (Edge Function to app)", () => {
    const product = returnedProduct();
    const received = JSON.parse(JSON.stringify(product)) as Product;
    expect(isDisplayUnchanged(received)).toBe(true);
  });

  it("fails for a product no adapter returned in this session", () => {
    const invented: Product = { ...returnedProduct(), id: "0000000000000" };
    expect(() => assertDisplayUnchanged(invented)).toThrow(RetailerTermsError);
  });

  it("accepts the same id at two stores with two prices", () => {
    const here = returnedProduct();
    const there = { ...here, price: 6.49 };
    rememberReturned(there);
    expect(isDisplayUnchanged(here)).toBe(true);
    expect(isDisplayUnchanged(there)).toBe(true);
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
