import { describe, expect, it } from "vitest";
import { allergenLevel, mapAllergens, mapProduct } from "./mappers.ts";

describe("allergen levels", () => {
  // The five levelOfContainmentName values seen on live QFC products (1,525 entries, 2026-10-30).
  it.each([
    ["Contains", "contains"],
    ["May contain", "may_contain"],
    ["Free from", "absent"],
    ["Not intentionally nor inherently included", "absent"],
    ["Undeclared", "undeclared"],
  ] as const)("reads %j as %s", (level, expected) => {
    expect(allergenLevel(level)).toBe(expected);
  });

  it("fails closed: a missing or unknown level counts as contains", () => {
    expect(allergenLevel(undefined)).toBe("contains");
    expect(allergenLevel("")).toBe("contains");
    expect(allergenLevel("Derived from")).toBe("contains");
    expect(allergenLevel("MAY CONTAIN")).toBe("may_contain");
  });

  it("keeps contains and may contain apart, and drops the absent ones", () => {
    expect(
      mapAllergens([
        { levelOfContainmentName: "Contains", name: "Milk and its derivates" },
        { levelOfContainmentName: "May contain", name: "Peanuts and its derivatives" },
        { levelOfContainmentName: "Free from", name: "Gluten" },
        {
          levelOfContainmentName: "Not intentionally nor inherently included",
          name: "Sesame Seeds and its derivatives",
        },
      ]),
    ).toEqual({
      allergens: ["Milk and its derivates", "Peanuts and its derivatives"],
      mayContain: ["Peanuts and its derivatives"],
      undeclared: [],
    });
  });

  it("keeps an undeclared allergen in the safety list, labelled as undeclared", () => {
    expect(
      mapAllergens([
        { levelOfContainmentName: "Undeclared", name: "Sesame" },
        { levelOfContainmentName: "Contains", name: "Wheat" },
      ]),
    ).toEqual({ allergens: ["Sesame", "Wheat"], mayContain: [], undeclared: ["Sesame"] });
  });

  it("keeps the strongest level when an allergen is listed twice", () => {
    expect(
      mapAllergens([
        { levelOfContainmentName: "Undeclared", name: "Soy" },
        { levelOfContainmentName: "May contain", name: "Soy" },
        { levelOfContainmentName: "Contains", name: "Soy" },
        { levelOfContainmentName: "May contain", name: "Soy" },
        { levelOfContainmentName: "Undeclared", name: "Egg" },
        { levelOfContainmentName: "May contain", name: "Egg" },
      ]),
    ).toEqual({ allergens: ["Soy", "Egg"], mayContain: ["Egg"], undeclared: [] });
  });

  it("puts both lists on the product", () => {
    const product = mapProduct(
      {
        productId: "0009990009001",
        description: "Fixture Trail Mix",
        allergens: [
          { levelOfContainmentName: "Contains", name: "Tree Nuts" },
          { levelOfContainmentName: "May contain", name: "Peanuts" },
          { levelOfContainmentName: "Not intentionally nor inherently included", name: "Milk" },
          { levelOfContainmentName: "Undeclared", name: "Sesame" },
        ],
      },
      0,
    );
    expect(product.allergens).toEqual(["Tree Nuts", "Peanuts", "Sesame"]);
    expect(product.mayContain).toEqual(["Peanuts"]);
    expect(product.undeclared).toEqual(["Sesame"]);
  });
});
