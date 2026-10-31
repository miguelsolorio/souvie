import { describe, expect, it } from "vitest";
import { containerOf, detectContainer, isContainerUnit } from "./containers.ts";
import type { ListIngredientLine } from "./types.ts";

const line = (overrides: Partial<ListIngredientLine>): ListIngredientLine => ({
  id: "00000000-0000-4000-8000-000000000001",
  position: 0,
  raw_text: "x",
  qty: null,
  unit: null,
  ingredient_id: null,
  prep_note: null,
  optional: false,
  ...overrides,
});

describe("detectContainer: the two patterns the WS03 review named", () => {
  it("2 (14 oz) cans is 2 cans of 14 oz", () => {
    expect(detectContainer("2 (14 oz) cans diced tomatoes")).toEqual({
      count: 2,
      container: "can",
      size: { qty: 14, unit: "oz" },
    });
  });

  it("2 cans (14 oz each) is 2 cans of 14 oz", () => {
    expect(detectContainer("2 cans (14 oz each) diced tomatoes")).toEqual({
      count: 2,
      container: "can",
      size: { qty: 14, unit: "oz" },
    });
  });

  it("1 (28 oz) can is one 28 oz can", () => {
    expect(detectContainer("1 (28 oz) can crushed tomatoes")).toEqual({
      count: 1,
      container: "can",
      size: { qty: 28, unit: "oz" },
    });
  });
});

describe("detectContainer: common variants", () => {
  it.each([
    ["1 can (15 oz) tomato sauce", 1, "can", 15, "oz"],
    ["1 jar (24 oz) marinara sauce", 1, "jar", 24, "oz"],
    ["2 (14.5-ounce) cans diced tomatoes", 2, "can", 14.5, "oz"],
    ["1 (28-ounce) can whole peeled tomatoes", 1, "can", 28, "oz"],
    ["2 (14.5 oz.) cans fire-roasted tomatoes", 2, "can", 14.5, "oz"],
    ["1 14-ounce can coconut milk", 1, "can", 14, "oz"],
    ["2 15 oz cans chickpeas", 2, "can", 15, "oz"],
    ["a 14 oz can tomato paste", 1, "can", 14, "oz"],
    ["3 packages (8 oz each) cream cheese", 3, "package", 8, "oz"],
    ["1 bag (16 oz) frozen peas", 1, "bag", 16, "oz"],
    ["2 cans, 14 oz each, black beans", 2, "can", 14, "oz"],
    ["1 (400 g) tin chickpeas", 1, "can", 400, "g"],
    ["1 (13.5 fl oz) can coconut milk", 1, "can", 13.5, "fl_oz"],
  ])("%s", (text, count, container, qty, unit) => {
    expect(detectContainer(text)).toEqual({ count, container, size: { qty, unit } });
  });

  it("finds a container without a size", () => {
    expect(detectContainer("2 cans")).toBeNull();
  });

  it.each([
    "1 cup diced tomatoes",
    "2 cups (500 ml) milk",
    "1/2 (14 oz) can tomatoes",
    "2 large (14 oz) onions",
    "1 can black beans, 14 large tomatoes",
    "salt to taste",
    "2 14 large carrots",
    "1 tbsp (15 g) butter",
  ])("leaves %s as a plain line", (text) => {
    expect(detectContainer(text)).toBeNull();
  });

  it("does not take the l of 'large' for liters", () => {
    expect(detectContainer("1 can 14 large tomatoes")).toBeNull();
  });
});

describe("containerOf: columns first, raw text second", () => {
  it("reads the CCR5 columns and divides the total by the count for the size", () => {
    expect(
      containerOf(
        line({
          raw_text: "2 (14 oz) cans diced tomatoes",
          qty: 28,
          unit: "oz",
          container_count: 2,
          container: "can",
        }),
      ),
    ).toEqual({ count: 2, container: "can", size: { qty: 14, unit: "oz" } });
  });

  it("takes the size from the raw text when the columns hold the count in cans", () => {
    expect(
      containerOf(
        line({
          raw_text: "2 cans (15 oz each) black beans",
          qty: 2,
          unit: "can",
          container_count: 2,
          container: "can",
        }),
      ),
    ).toEqual({ count: 2, container: "can", size: { qty: 15, unit: "oz" } });
  });

  it("trusts the columns over the raw text", () => {
    expect(
      containerOf(
        line({
          raw_text: "1 (28 oz) can tomatoes",
          qty: 56,
          unit: "oz",
          container_count: 2,
          container: "can",
        }),
      )?.count,
    ).toBe(2);
  });

  it("falls back to the raw text for the shapes the parser leaves unfilled", () => {
    expect(
      containerOf(line({ raw_text: "2 (14 oz) cans diced tomatoes", qty: 28, unit: "oz" })),
    ).toEqual({ count: 2, container: "can", size: { qty: 14, unit: "oz" } });
    expect(
      containerOf(line({ raw_text: "2 cans (14 oz each) diced tomatoes", qty: 2, unit: "can" })),
    ).toEqual({ count: 2, container: "can", size: { qty: 14, unit: "oz" } });
    expect(
      containerOf(line({ raw_text: "1 (28 oz) can crushed tomatoes", qty: 28, unit: "oz" })),
    ).toEqual({ count: 1, container: "can", size: { qty: 28, unit: "oz" } });
  });

  it("ignores the raw text when the parsed quantity disagrees with it", () => {
    expect(
      containerOf(line({ raw_text: "2 (14 oz) cans diced tomatoes", qty: 3, unit: "cup" })),
    ).toBeNull();
    expect(
      containerOf(line({ raw_text: "2 (14 oz) cans diced tomatoes", qty: 99, unit: "oz" })),
    ).toBeNull();
  });

  it("is null for a plain line and for a bare can count", () => {
    expect(containerOf(line({ raw_text: "1 cup flour", qty: 1, unit: "cup" }))).toBeNull();
    expect(containerOf(line({ raw_text: "2 cans black beans", qty: 2, unit: "can" }))).toBeNull();
  });
});

describe("isContainerUnit", () => {
  it("knows containers by any spelling and nothing else", () => {
    for (const unit of ["can", "cans", "tin", "jar", "pkg", "bag", "box", "bottle"]) {
      expect(isContainerUnit(unit), unit).toBe(true);
    }
    for (const unit of ["cup", "oz", "each", "clove", "head", "stick", null, undefined, ""]) {
      expect(isContainerUnit(unit as string | null), String(unit)).toBe(false);
    }
  });
});
