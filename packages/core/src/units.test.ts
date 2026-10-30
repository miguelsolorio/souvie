import { describe, expect, it } from "vitest";
import {
  convert,
  isUnitCode,
  normalizeUnit,
  toPurchasable,
  UNIT_ALIASES,
  UNIT_CODES,
  type UnitIngredient,
  unitDimension,
} from "./units";

// Values mirror supabase/seed/ingredients.csv.
const flour: UnitIngredient = {
  name: "all-purpose flour",
  category: "baking",
  defaultUnit: "cup",
  densityGPerMl: 0.53,
  typicalUnitWeightG: null,
};
const sugar: UnitIngredient = {
  name: "granulated sugar",
  category: "baking",
  defaultUnit: "cup",
  densityGPerMl: 0.85,
  typicalUnitWeightG: null,
};
const butter: UnitIngredient = {
  name: "butter",
  category: "dairy",
  defaultUnit: "tbsp",
  densityGPerMl: 0.96,
  typicalUnitWeightG: null,
};
const milk: UnitIngredient = {
  name: "milk",
  category: "dairy",
  defaultUnit: "cup",
  densityGPerMl: 1.03,
  typicalUnitWeightG: null,
};
const garlic: UnitIngredient = {
  name: "garlic",
  category: "produce",
  defaultUnit: "clove",
  densityGPerMl: null,
  typicalUnitWeightG: 5,
};
const onion: UnitIngredient = {
  name: "yellow onion",
  category: "produce",
  defaultUnit: "each",
  densityGPerMl: null,
  typicalUnitWeightG: 150,
};
const egg: UnitIngredient = {
  name: "egg",
  category: "eggs",
  defaultUnit: "each",
  densityGPerMl: null,
  typicalUnitWeightG: 50,
};
const chicken: UnitIngredient = {
  name: "chicken breast",
  category: "meat",
  defaultUnit: "lb",
  densityGPerMl: null,
  typicalUnitWeightG: 225,
};
const cumin: UnitIngredient = {
  name: "cumin",
  category: "spices",
  defaultUnit: "tsp",
  densityGPerMl: 0.45,
  typicalUnitWeightG: null,
};
const blackBeans: UnitIngredient = {
  name: "black beans",
  category: "canned",
  defaultUnit: "can",
  densityGPerMl: 0.75,
  typicalUnitWeightG: null,
};
const saltNoDensity: UnitIngredient = {
  name: "mystery salt",
  category: "spices",
  defaultUnit: "tsp",
  densityGPerMl: null,
  typicalUnitWeightG: null,
};

describe("normalizeUnit", () => {
  it.each([
    ["cup", "cup"],
    ["Cups", "cup"],
    ["c", "cup"],
    ["C.", "cup"],
    ["tablespoon", "tbsp"],
    ["Tbsp.", "tbsp"],
    ["tbs", "tbsp"],
    ["T", "tbsp"],
    ["teaspoons", "tsp"],
    ["t", "tsp"],
    ["fl oz", "fl_oz"],
    ["fluid ounces", "fl_oz"],
    ["oz", "oz"],
    ["Ounces", "oz"],
    ["lbs", "lb"],
    ["pound", "lb"],
    ["g", "g"],
    ["kilograms", "kg"],
    ["mL", "ml"],
    ["L", "l"],
    ["litres", "l"],
    ["cloves", "clove"],
    ["heads", "head"],
    ["bunches", "bunch"],
    ["tins", "can"],
    ["pkg", "package"],
    ["sticks", "stick"],
    ["loaves", "loaf"],
    ["ribs", "stalk"],
    ["Large", "large"],
    ["doz", "dozen"],
    ["ea", "each"],
  ])("maps %s to %s", (raw, code) => {
    expect(normalizeUnit(raw)).toBe(code);
  });

  it("returns null for unknown or empty input", () => {
    expect(normalizeUnit("")).toBeNull();
    expect(normalizeUnit("  ")).toBeNull();
    expect(normalizeUnit(null)).toBeNull();
    expect(normalizeUnit(undefined)).toBeNull();
    expect(normalizeUnit("handfuls of")).toBeNull();
    expect(normalizeUnit("onion")).toBeNull();
  });

  it("keeps every canonical code reachable and typed", () => {
    for (const code of UNIT_CODES) {
      expect(isUnitCode(code)).toBe(true);
      expect(UNIT_ALIASES[code]).toBe(code);
      expect(["volume", "weight", "count"]).toContain(unitDimension(code));
    }
    expect(isUnitCode("cups")).toBe(false);
  });

  it("lists the units the brief requires", () => {
    for (const word of [
      "cup",
      "c",
      "tbsp",
      "tablespoon",
      "tsp",
      "oz",
      "fl oz",
      "lb",
      "g",
      "kg",
      "ml",
      "l",
      "pinch",
      "clove",
      "head",
      "bunch",
      "can",
      "package",
      "slice",
      "large",
      "medium",
      "small",
      "each",
    ]) {
      expect(UNIT_ALIASES[word], word).toBeDefined();
    }
  });
});

describe("convert within a dimension (no ingredient needed)", () => {
  it("volume: 3 tsp is 1 tbsp", () => {
    expect(convert(3, "tsp", "tbsp")).toBeCloseTo(1, 6);
  });
  it("volume: 16 tbsp is 1 cup", () => {
    expect(convert(16, "tbsp", "cup")).toBeCloseTo(1, 6);
  });
  it("volume: 4 cups is 1 quart", () => {
    expect(convert(4, "cup", "quart")).toBeCloseTo(1, 6);
  });
  it("volume: 1 cup is 8 fl oz", () => {
    expect(convert(1, "cup", "fl oz")).toBeCloseTo(8, 6);
  });
  it("volume: 1 cup is about 236.6 ml", () => {
    expect(convert(1, "cup", "ml")).toBeCloseTo(236.588, 2);
  });
  it("volume: a pinch is a sixteenth of a teaspoon", () => {
    expect(convert(1, "pinch", "tsp")).toBeCloseTo(1 / 16, 6);
  });
  it("weight: 1 lb is 16 oz", () => {
    expect(convert(1, "lb", "oz")).toBeCloseTo(16, 6);
  });
  it("weight: 500 g is 0.5 kg", () => {
    expect(convert(500, "g", "kg")).toBeCloseTo(0.5, 6);
  });
  it("weight: 1 lb is about 453.6 g", () => {
    expect(convert(1, "lb", "g")).toBeCloseTo(453.592, 2);
  });
  it("same unit returns the quantity untouched", () => {
    expect(convert(1.3, "lb", "lb", chicken)).toBe(1.3);
    expect(convert(7, "clove", "clove")).toBe(7);
  });
  it("accepts aliases on both sides", () => {
    expect(convert(2, "tablespoons", "tsp")).toBeCloseTo(6, 6);
  });
  it("size words and dozens relate without a weight", () => {
    expect(convert(1, "dozen", "each")).toBe(12);
    expect(convert(2, "large", "medium")).toBeCloseTo(2.5, 6);
    expect(convert(1, "each", "medium")).toBe(1);
  });
});

describe("convert across dimensions", () => {
  it("1 cup flour is 120 to 130 g (named case)", () => {
    const g = convert(1, "cup", "g", flour);
    expect(g).not.toBeNull();
    expect(g as number).toBeGreaterThanOrEqual(120);
    expect(g as number).toBeLessThanOrEqual(130);
  });
  it("1 cup sugar is about 200 g", () => {
    expect(convert(1, "cup", "g", sugar)).toBeCloseTo(201.1, 0);
  });
  it("1 tbsp butter is about 14 g", () => {
    expect(convert(1, "tbsp", "g", butter)).toBeCloseTo(14.2, 0);
  });
  it("1 cup milk is about 244 g", () => {
    expect(convert(1, "cup", "g", milk)).toBeCloseTo(243.7, 0);
  });
  it("250 g flour is about 2 cups (weight to volume)", () => {
    expect(convert(250, "g", "cup", flour)).toBeCloseTo(1.99, 1);
  });
  it("1 lb butter is about 2 cups", () => {
    expect(convert(1, "lb", "cup", butter)).toBeCloseTo(2.0, 1);
  });
  it("1 tsp cumin is about 2.2 g", () => {
    expect(convert(1, "tsp", "g", cumin)).toBeCloseTo(2.2, 1);
  });
  it("2 cloves garlic is at most 1 head (named case)", () => {
    const heads = convert(2, "clove", "head", garlic);
    expect(heads).not.toBeNull();
    expect(heads as number).toBeLessThanOrEqual(1);
    expect(heads as number).toBeCloseTo(0.2, 6);
  });
  it("2 medium onions is 300 g", () => {
    expect(convert(2, "medium", "g", onion)).toBeCloseTo(300, 6);
  });
  it("a large onion weighs more than a small one", () => {
    const large = convert(1, "large", "g", onion) as number;
    const small = convert(1, "small", "g", onion) as number;
    expect(large).toBeGreaterThan(small);
  });
  it("300 g onion is 2 each", () => {
    expect(convert(300, "g", "each", onion)).toBeCloseTo(2, 6);
  });
  it("3 eggs is 150 g", () => {
    expect(convert(3, "each", "g", egg)).toBeCloseTo(150, 6);
  });
  it("a dozen eggs is 600 g", () => {
    expect(convert(1, "dozen", "g", egg)).toBeCloseTo(600, 6);
  });
  it("1 lb chicken breast is about 2 breasts", () => {
    expect(convert(1, "lb", "each", chicken)).toBeCloseTo(2.02, 1);
  });
  it("a stick of butter is 113 g and a half cup", () => {
    expect(convert(1, "stick", "g", butter)).toBeCloseTo(113, 6);
    expect(convert(1, "stick", "cup", butter)).toBeCloseTo(0.5, 1);
  });
  it("a can of black beans uses the canned-goods default", () => {
    expect(convert(1, "can", "g", blackBeans)).toBeCloseTo(411, 6);
  });
  it("returns null when density is missing", () => {
    expect(convert(1, "cup", "g", saltNoDensity)).toBeNull();
    expect(convert(1, "cup", "g", null)).toBeNull();
    expect(convert(1, "cup", "g")).toBeNull();
  });
  it("returns null when a count unit has no known weight", () => {
    expect(convert(1, "each", "g", flour)).toBeNull();
    expect(convert(1, "bunch", "g", onion)).toBeNull();
  });
  it("returns null for unknown units and bad numbers", () => {
    expect(convert(1, "furlong", "g", flour)).toBeNull();
    expect(convert(1, "cup", "bushel", flour)).toBeNull();
    expect(convert(Number.NaN, "cup", "g", flour)).toBeNull();
  });
});

describe("toPurchasable", () => {
  it("1.3 lb chicken becomes 1.5 lb (named case)", () => {
    expect(toPurchasable(1.3, "lb", chicken)).toEqual({ qty: 1.5, unit: "lb", basis: "weight" });
  });
  it("1.5 lb chicken stays 1.5 lb", () => {
    expect(toPurchasable(1.5, "lb", chicken)).toEqual({ qty: 1.5, unit: "lb", basis: "weight" });
  });
  it("1.01 lb chicken goes up to 1.5 lb", () => {
    expect(toPurchasable(1.01, "lb", chicken)?.qty).toBe(1.5);
  });
  it("24 oz chicken is 1.5 lb", () => {
    expect(toPurchasable(24, "oz", chicken)).toEqual({ qty: 1.5, unit: "lb", basis: "weight" });
  });
  it("2 cloves garlic is 1 head (named case)", () => {
    expect(toPurchasable(2, "clove", garlic)).toEqual({ qty: 1, unit: "head", basis: "pack" });
  });
  it("12 cloves garlic is 2 heads", () => {
    expect(toPurchasable(12, "clove", garlic)).toEqual({ qty: 2, unit: "head", basis: "pack" });
  });
  it("1.5 cups flour is 1 bag", () => {
    expect(toPurchasable(1.5, "cup", flour)).toEqual({ qty: 1, unit: "bag", basis: "pack" });
  });
  it("20 cups flour is 2 bags", () => {
    expect(toPurchasable(20, "cup", flour)?.qty).toBe(2);
  });
  it("3 eggs is 1 dozen and 13 eggs is 2", () => {
    expect(toPurchasable(3, "each", egg)).toEqual({ qty: 1, unit: "dozen", basis: "pack" });
    expect(toPurchasable(13, "each", egg)?.qty).toBe(2);
  });
  it("1 cup butter is 2 sticks", () => {
    expect(toPurchasable(1, "cup", butter)).toEqual({ qty: 2, unit: "stick", basis: "pack" });
  });
  it("2 cups milk is 1 quart", () => {
    expect(toPurchasable(2, "cup", milk)).toEqual({ qty: 1, unit: "quart", basis: "pack" });
  });
  it("a 15 oz can requirement fits one 14.5 oz can", () => {
    expect(toPurchasable(15, "oz", blackBeans)).toEqual({ qty: 1, unit: "can", basis: "pack" });
  });
  it("2 tsp cumin is 1 jar", () => {
    expect(toPurchasable(2, "tsp", cumin)).toEqual({ qty: 1, unit: "jar", basis: "pack" });
  });
  it("2.2 onions round up to 3 each", () => {
    expect(toPurchasable(2.2, "each", onion)).toEqual({ qty: 3, unit: "each", basis: "count" });
  });
  it("volume that cannot be packed (no density) rounds up to a quarter", () => {
    expect(toPurchasable(1.1, "cup", saltNoDensity)).toEqual({
      qty: 1.25,
      unit: "cup",
      basis: "volume",
    });
  });
  it("small weights stay in ounces for non-meat items", () => {
    const grain = { ...saltNoDensity, name: "mystery grain", category: "pantry" };
    expect(toPurchasable(3.2, "oz", grain)).toEqual({ qty: 4, unit: "oz", basis: "weight" });
  });
  it("returns null for an unknown unit and clamps zero", () => {
    expect(toPurchasable(1, "furlong", chicken)).toBeNull();
    expect(toPurchasable(-1, "lb", chicken)).toBeNull();
    expect(toPurchasable(0, "lb", chicken)?.qty).toBe(0);
  });
});
