import { describe, expect, it } from "vitest";
import { INGREDIENT_CATEGORIES } from "../ingredient.ts";
import { formatAmount, formatQty, unitLabel } from "./format.ts";
import {
  compareSections,
  DEFAULT_SECTION_ORDER,
  groupBySection,
  isKnownSection,
  resolveSectionOrder,
  SECTION_LABELS,
  sectionLabel,
  sectionOrderFor,
} from "./sections.ts";

describe("default section order", () => {
  it("is docs/03 section 6, with every ingredient category exactly once", () => {
    expect([...DEFAULT_SECTION_ORDER]).toEqual([
      "produce",
      "bakery",
      "meat",
      "seafood",
      "dairy",
      "eggs",
      "pantry",
      "canned",
      "baking",
      "spices",
      "international",
      "snacks",
      "frozen",
      "beverages",
      "household",
      "other",
    ]);
    expect([...DEFAULT_SECTION_ORDER].sort()).toEqual([...INGREDIENT_CATEGORIES].sort());
  });

  it("has a label for every section", () => {
    for (const section of DEFAULT_SECTION_ORDER) expect(SECTION_LABELS[section]).toBeTruthy();
    expect(sectionLabel("canned")).toBe("Canned goods");
    expect(sectionLabel("deli")).toBe("Deli");
    expect(sectionLabel("constructor")).toBe("Constructor");
  });
});

describe("resolveSectionOrder", () => {
  it("is the default with no override", () => {
    expect(resolveSectionOrder()).toEqual([...DEFAULT_SECTION_ORDER]);
    expect(resolveSectionOrder(null)).toEqual([...DEFAULT_SECTION_ORDER]);
    expect(resolveSectionOrder([])).toEqual([...DEFAULT_SECTION_ORDER]);
  });

  it("puts the override first and the rest in default order, dropping repeats", () => {
    const order = resolveSectionOrder(["frozen", "produce", "frozen", "deli"]);
    expect(order.slice(0, 4)).toEqual(["frozen", "produce", "deli", "bakery"]);
    expect(new Set(order).size).toBe(order.length);
    expect(order).toHaveLength(DEFAULT_SECTION_ORDER.length + 1);
  });

  it("prefers the household over the store, and falls back to the default", () => {
    expect(sectionOrderFor({ household: ["meat"] })[0]).toBe("meat");
    expect(sectionOrderFor({ household: [], storeId: "nope" })).toEqual([...DEFAULT_SECTION_ORDER]);
    expect(sectionOrderFor({ storeId: "constructor" })).toEqual([...DEFAULT_SECTION_ORDER]);
    expect(sectionOrderFor({})).toEqual([...DEFAULT_SECTION_ORDER]);
  });
});

describe("groupBySection", () => {
  const items = [
    { section: "dairy", name: "milk" },
    { section: "produce", name: "kale" },
    { section: "dairy", name: "cheese" },
    { section: "mystery", name: "thing" },
    { section: "meat", name: "beef" },
  ];

  it("groups in store order, keeps item order, and puts unknown sections last", () => {
    const groups = groupBySection(items);
    expect(groups.map((g) => g.section)).toEqual(["produce", "meat", "dairy", "mystery"]);
    expect(groups[2]?.items.map((i) => i.name)).toEqual(["milk", "cheese"]);
    expect(groups[0]?.label).toBe("Produce");
  });

  it("follows another order", () => {
    const groups = groupBySection(items, resolveSectionOrder(["dairy"]));
    expect(groups.map((g) => g.section)).toEqual(["dairy", "produce", "meat", "mystery"]);
  });

  it("sorts sections the order does not know alphabetically after the known ones", () => {
    expect(compareSections(DEFAULT_SECTION_ORDER, "zzz", "aaa")).toBeGreaterThan(0);
    expect(compareSections(DEFAULT_SECTION_ORDER, "other", "zzz")).toBeLessThan(0);
  });

  it("knows the sixteen", () => {
    expect(isKnownSection("produce")).toBe(true);
    expect(isKnownSection("deli")).toBe(false);
  });
});

describe("formatQty and formatAmount", () => {
  it.each([
    [2, "2"],
    [1.5, "1½"],
    [0.5, "½"],
    [0.25, "¼"],
    [0.75, "¾"],
    [1 / 3, "⅓"],
    [2 + 2 / 3, "2⅔"],
    [0.125, "⅛"],
    [0.3, "0.3"],
    [1.2, "1.2"],
    [12.0000001, "12"],
    [2.7, "2.7"],
  ])("%s reads %s", (qty, text) => {
    expect(formatQty(qty)).toBe(text);
  });

  it("writes units the way a list reads", () => {
    expect(formatAmount(2, "cup")).toBe("2 cups");
    expect(formatAmount(1, "cup")).toBe("1 cup");
    expect(formatAmount(1.5, "lb")).toBe("1½ lb");
    expect(formatAmount(2, "head")).toBe("2 heads");
    expect(formatAmount(3, "each")).toBe("3");
    expect(formatAmount(1, "dozen")).toBe("1 dozen");
    expect(formatAmount(2, "bunch")).toBe("2 bunches");
    expect(formatAmount(3, "tbsp")).toBe("3 tbsp");
    expect(formatAmount(2, "knob")).toBe("2 knob");
    expect(formatAmount(null, "cup")).toBe("");
    expect(formatAmount(4, null)).toBe("4");
    expect(unitLabel("cans", 2)).toBe("cans");
    expect(unitLabel("can", 1)).toBe("can");
    expect(unitLabel(null)).toBe("");
  });
});
