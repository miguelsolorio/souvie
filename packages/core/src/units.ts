// Unit dictionary, conversion, and purchasable rounding (WS03).
// Pure code, no I/O. Aggregation (WS05) and line-item conversion (WS09) build on this module.
//
// Three dimensions:
//   volume  tsp ... gallon, ml, l, plus the tiny measures pinch, dash, drop
//   weight  g, kg, oz, lb
//   count   each, the size words, dozen, and containers such as clove, head, bunch, can
//
// Volume and weight meet through `densityGPerMl`. Count meets weight through the ingredient's
// `typicalUnitWeightG` and a small table of container weights. Anything that cannot be
// converted honestly returns null, never a guess.
//
// Relative imports carry the .ts extension so Deno (Edge Functions) can load this file.

/** The fields of an ingredient that unit conversion reads. `Ingredient` satisfies it. */
export interface UnitIngredient {
  name: string;
  category: string;
  defaultUnit: string;
  densityGPerMl: number | null;
  typicalUnitWeightG: number | null;
}

export type UnitDimension = "volume" | "weight" | "count";

export const UNIT_CODES = [
  // volume
  "tsp",
  "tbsp",
  "fl_oz",
  "cup",
  "pint",
  "quart",
  "gallon",
  "ml",
  "l",
  "pinch",
  "dash",
  "drop",
  // weight
  "g",
  "kg",
  "oz",
  "lb",
  // count
  "each",
  "small",
  "medium",
  "large",
  "dozen",
  "clove",
  "head",
  "bunch",
  "can",
  "package",
  "packet",
  "slice",
  "stick",
  "sprig",
  "stalk",
  "piece",
  "bag",
  "jar",
  "bottle",
  "box",
  "ear",
  "fillet",
  "sheet",
  "loaf",
  "scoop",
  "handful",
  "block",
  "carton",
  "tub",
  "tube",
  "container",
  "link",
  "rack",
  "slab",
  "recipe",
] as const;

export type UnitCode = (typeof UNIT_CODES)[number];

interface UnitDef {
  dimension: UnitDimension;
  /** Milliliters per unit (volume) or grams per unit (weight). Unused for count units. */
  perBase?: number;
}

const UNIT_DEFS: Record<UnitCode, UnitDef> = {
  tsp: { dimension: "volume", perBase: 4.92892159375 },
  tbsp: { dimension: "volume", perBase: 14.78676478125 },
  fl_oz: { dimension: "volume", perBase: 29.5735295625 },
  cup: { dimension: "volume", perBase: 236.5882365 },
  pint: { dimension: "volume", perBase: 473.176473 },
  quart: { dimension: "volume", perBase: 946.352946 },
  gallon: { dimension: "volume", perBase: 3785.411784 },
  ml: { dimension: "volume", perBase: 1 },
  l: { dimension: "volume", perBase: 1000 },
  pinch: { dimension: "volume", perBase: 4.92892159375 / 16 },
  dash: { dimension: "volume", perBase: 4.92892159375 / 8 },
  drop: { dimension: "volume", perBase: 0.05 },
  g: { dimension: "weight", perBase: 1 },
  kg: { dimension: "weight", perBase: 1000 },
  oz: { dimension: "weight", perBase: 28.349523125 },
  lb: { dimension: "weight", perBase: 453.59237 },
  each: { dimension: "count" },
  small: { dimension: "count" },
  medium: { dimension: "count" },
  large: { dimension: "count" },
  dozen: { dimension: "count" },
  clove: { dimension: "count" },
  head: { dimension: "count" },
  bunch: { dimension: "count" },
  can: { dimension: "count" },
  package: { dimension: "count" },
  packet: { dimension: "count" },
  slice: { dimension: "count" },
  stick: { dimension: "count" },
  sprig: { dimension: "count" },
  stalk: { dimension: "count" },
  piece: { dimension: "count" },
  bag: { dimension: "count" },
  jar: { dimension: "count" },
  bottle: { dimension: "count" },
  box: { dimension: "count" },
  ear: { dimension: "count" },
  fillet: { dimension: "count" },
  sheet: { dimension: "count" },
  loaf: { dimension: "count" },
  scoop: { dimension: "count" },
  handful: { dimension: "count" },
  block: { dimension: "count" },
  carton: { dimension: "count" },
  tub: { dimension: "count" },
  tube: { dimension: "count" },
  container: { dimension: "count" },
  link: { dimension: "count" },
  rack: { dimension: "count" },
  slab: { dimension: "count" },
  recipe: { dimension: "count" },
};

/**
 * Multiplier from "one each" to one of the size words. `typicalUnitWeightG` describes the
 * unmarked item (a medium onion, about 150 g), so small is lighter and large heavier.
 */
const ITEM_FACTORS: Partial<Record<UnitCode, number>> = {
  each: 1,
  small: 0.8,
  medium: 1,
  large: 1.25,
  dozen: 12,
};

// ---------------------------------------------------------------------------
// Aliases
// ---------------------------------------------------------------------------

const ALIAS_GROUPS: Record<UnitCode, readonly string[]> = {
  tsp: ["tsp", "tsps", "tsp.", "teaspoon", "teaspoons", "teasp", "tspn", "t."],
  tbsp: [
    "tbsp",
    "tbsps",
    "tbsp.",
    "tbs",
    "tbs.",
    "tbl",
    "tbls",
    "tblsp",
    "tblspn",
    "tablespoon",
    "tablespoons",
  ],
  fl_oz: ["fl oz", "fl. oz", "fl. oz.", "fl-oz", "floz", "fluid ounce", "fluid ounces", "fluid oz"],
  cup: ["cup", "cups", "c", "c."],
  pint: ["pint", "pints", "pt", "pt."],
  quart: ["quart", "quarts", "qt", "qt.", "qts"],
  gallon: ["gallon", "gallons", "gal", "gal."],
  ml: ["ml", "mls", "milliliter", "milliliters", "millilitre", "millilitres", "cc"],
  l: ["l", "liter", "liters", "litre", "litres", "ltr"],
  pinch: ["pinch", "pinches"],
  dash: ["dash", "dashes"],
  drop: ["drop", "drops"],
  g: ["g", "gram", "grams", "gm", "gr", "g."],
  kg: ["kg", "kgs", "kilogram", "kilograms", "kilo", "kilos"],
  oz: ["oz", "oz.", "ozs", "ounce", "ounces"],
  lb: ["lb", "lbs", "lb.", "lbs.", "pound", "pounds", "#"],
  each: ["each", "ea", "ea."],
  small: ["small", "sm", "small-sized", "small sized"],
  medium: ["medium", "med", "med.", "medium-sized", "medium sized"],
  large: [
    "large",
    "lg",
    "lg.",
    "extra-large",
    "extra large",
    "jumbo",
    "large-sized",
    "large sized",
  ],
  dozen: ["dozen", "doz", "doz."],
  clove: ["clove", "cloves"],
  head: ["head", "heads"],
  bunch: ["bunch", "bunches"],
  can: ["can", "cans", "tin", "tins"],
  package: ["package", "packages", "pkg", "pkg.", "pkgs", "pack", "packs"],
  packet: ["packet", "packets", "envelope", "envelopes", "sachet", "sachets"],
  slice: ["slice", "slices"],
  stick: ["stick", "sticks"],
  sprig: ["sprig", "sprigs"],
  stalk: ["stalk", "stalks", "rib", "ribs"],
  piece: ["piece", "pieces", "pc", "pcs"],
  bag: ["bag", "bags"],
  jar: ["jar", "jars"],
  bottle: ["bottle", "bottles"],
  box: ["box", "boxes"],
  ear: ["ear", "ears"],
  fillet: ["fillet", "fillets", "filet", "filets"],
  sheet: ["sheet", "sheets"],
  loaf: ["loaf", "loaves"],
  scoop: ["scoop", "scoops"],
  handful: ["handful", "handfuls"],
  block: ["block", "blocks"],
  carton: ["carton", "cartons"],
  tub: ["tub", "tubs"],
  tube: ["tube", "tubes"],
  container: ["container", "containers"],
  link: ["link", "links"],
  rack: ["rack", "racks"],
  slab: ["slab", "slabs"],
  recipe: ["recipe", "recipes", "batch", "batches"],
};

/** Every spelling (lowercase) mapped to its canonical code. */
export const UNIT_ALIASES: Readonly<Record<string, UnitCode>> = (() => {
  const out: Record<string, UnitCode> = {};
  for (const code of UNIT_CODES) {
    out[code] = code;
    for (const alias of ALIAS_GROUPS[code]) out[alias] = code;
  }
  return out;
})();

/** Longest alias in words, so a tokenizer knows how far ahead to look ("fl oz" is two). */
export const MAX_UNIT_ALIAS_WORDS = Math.max(
  ...Object.keys(UNIT_ALIASES).map((a) => a.split(" ").length),
);

/**
 * Own-key lookup on a plain object. A bare `table[key]` also finds inherited properties, so
 * `table["constructor"]` is a function. Anything that indexes a table by text from a recipe
 * or a database row goes through this.
 */
function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

export function isUnitCode(value: string): value is UnitCode {
  return Object.hasOwn(UNIT_DEFS, value);
}

/**
 * Canonical unit code for a raw unit string, or null if it is not a known unit.
 * Case matters only for the single letters recipes use: "T" is a tablespoon, "t" a teaspoon.
 */
export function normalizeUnit(raw: string | null | undefined): UnitCode | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (trimmed === "T" || trimmed === "T.") return "tbsp";
  if (trimmed === "t") return "tsp";
  const key = trimmed.toLowerCase().replace(/\s+/g, " ");
  return own(UNIT_ALIASES, key) ?? own(UNIT_ALIASES, key.replace(/\.$/, "")) ?? null;
}

export function unitDimension(unit: UnitCode): UnitDimension {
  return UNIT_DEFS[unit].dimension;
}

// ---------------------------------------------------------------------------
// Container weights
// ---------------------------------------------------------------------------

/**
 * Grams in one container unit for ingredients where `typicalUnitWeightG` does not cover it.
 * Keys are ontology names. `typicalUnitWeightG` wins when it describes the same unit
 * (see `unitWeightG`).
 */
export const CONTAINER_WEIGHTS_G: Readonly<Record<string, Partial<Record<UnitCode, number>>>> = {
  garlic: { head: 50, clove: 5 },
  "green onion": { each: 15, stalk: 15, bunch: 100 },
  celery: { bunch: 450, head: 450, stalk: 40 },
  ginger: { piece: 15, each: 15 },
  butter: { stick: 113, each: 113 },
  "unsalted butter": { stick: 113, each: 113 },
  kale: { bunch: 200 },
  spinach: { bunch: 340, bag: 283, package: 283 },
  "mixed greens": { bag: 142, package: 142, box: 142 },
  arugula: { bag: 142, package: 142 },
  asparagus: { bunch: 360 },
  "white mushroom": { package: 227, each: 18 },
  "cremini mushroom": { package: 227, each: 18 },
  carrot: { bag: 907, bunch: 500 },
  "russet potato": { bag: 2268 },
  "red potato": { bag: 1361 },
  "yellow onion": { bag: 1361 },
  lemon: { bag: 454 },
  lime: { bag: 454 },
  bacon: { package: 454, slice: 28 },
  "chicken breast": { package: 680 },
  "ground beef": { package: 454 },
  "cream cheese": { package: 227 },
  "flour tortilla": { package: 340 },
  "corn tortilla": { package: 340 },
  "hamburger bun": { package: 340 },
  "hot dog bun": { package: 340 },
  tofu: { package: 400 },
};

/** Container weights by store section, used when neither the ingredient nor the table knows. */
const CATEGORY_UNIT_WEIGHTS_G: Readonly<Record<string, Partial<Record<UnitCode, number>>>> = {
  canned: { can: 411 },
  spices: { jar: 56 },
};

const VOLUME_OR_WEIGHT = new Set<UnitDimension>(["volume", "weight"]);

/** Grams in one "each", or null when unknown. */
function eachWeightG(ing: UnitIngredient): number | null {
  const table = own(CONTAINER_WEIGHTS_G, ing.name)?.each;
  const defaultCode = normalizeUnit(ing.defaultUnit);
  if (ing.typicalUnitWeightG != null && defaultCode != null) {
    const dim = unitDimension(defaultCode);
    if (VOLUME_OR_WEIGHT.has(dim) || ITEM_FACTORS[defaultCode] === 1) {
      // The weight describes an individual item. For `each` it is the item; for `medium` the same.
      return ing.typicalUnitWeightG;
    }
  }
  return table ?? null;
}

/** Grams in one of a count unit for this ingredient, or null when unknown. */
function countUnitWeightG(unit: UnitCode, ing: UnitIngredient): number | null {
  const factor = ITEM_FACTORS[unit];
  if (factor !== undefined) {
    const each = eachWeightG(ing);
    return each == null ? null : each * factor;
  }
  const defaultCode = normalizeUnit(ing.defaultUnit);
  if (defaultCode === unit && ing.typicalUnitWeightG != null) return ing.typicalUnitWeightG;
  return (
    own(CONTAINER_WEIGHTS_G, ing.name)?.[unit] ??
    own(CATEGORY_UNIT_WEIGHTS_G, ing.category)?.[unit] ??
    null
  );
}

/** Grams in exactly one of `unit` for this ingredient, or null when it cannot be known. */
export function unitWeightG(unit: UnitCode, ing: UnitIngredient | null | undefined): number | null {
  const def = UNIT_DEFS[unit];
  if (def.dimension === "weight") return def.perBase ?? null;
  if (!ing) return null;
  if (def.dimension === "volume") {
    return ing.densityGPerMl != null && def.perBase != null
      ? ing.densityGPerMl * def.perBase
      : null;
  }
  return countUnitWeightG(unit, ing);
}

// ---------------------------------------------------------------------------
// convert
// ---------------------------------------------------------------------------

/**
 * Convert `qty` of `from` into `to`. Units may be canonical codes or any alias.
 * Returns null when a unit is unknown or the ingredient lacks the data to bridge dimensions.
 * Same-dimension volume and weight conversions need no ingredient.
 */
export function convert(
  qty: number,
  from: string,
  to: string,
  ingredient?: UnitIngredient | null,
): number | null {
  const f = normalizeUnit(from);
  const t = normalizeUnit(to);
  if (f == null || t == null || !Number.isFinite(qty)) return null;
  if (f === t) return qty;

  const fd = UNIT_DEFS[f];
  const td = UNIT_DEFS[t];

  if (fd.dimension === td.dimension && fd.perBase != null && td.perBase != null) {
    return (qty * fd.perBase) / td.perBase;
  }

  // Size words and dozens relate to each other without knowing any weight.
  const fi = ITEM_FACTORS[f];
  const ti = ITEM_FACTORS[t];
  if (fi !== undefined && ti !== undefined) return (qty * fi) / ti;

  const fromG = unitWeightG(f, ingredient);
  const toG = unitWeightG(t, ingredient);
  if (fromG == null || toG == null || toG === 0) return null;
  return (qty * fromG) / toG;
}

// ---------------------------------------------------------------------------
// toPurchasable
// ---------------------------------------------------------------------------

export interface PurchasableQuantity {
  qty: number;
  unit: UnitCode;
  /** How the number was reached, so a UI can explain "why this amount" (risk R2). */
  basis: "pack" | "weight" | "volume" | "count";
}

interface Pack {
  unit: UnitCode;
  /** Grams per pack. */
  grams?: number;
  /** Milliliters per pack. */
  ml?: number;
  /** Items per pack (eggs). */
  items?: number;
}

/**
 * Typical shelf packs. Not a catalog: WS09 picks the actual product. This only turns
 * "1.5 cups flour" into "1 bag" and "2 cloves garlic" into "1 head".
 */
export const PACK_SIZES: Readonly<Record<string, Pack>> = {
  garlic: { unit: "head", grams: 50 },
  "green onion": { unit: "bunch", grams: 100 },
  celery: { unit: "bunch", grams: 450 },
  butter: { unit: "stick", grams: 113 },
  "unsalted butter": { unit: "stick", grams: 113 },
  egg: { unit: "dozen", items: 12 },
  milk: { unit: "quart", ml: 946.352946 },
  buttermilk: { unit: "quart", ml: 946.352946 },
  "heavy cream": { unit: "pint", ml: 473.176473 },
  "half-and-half": { unit: "pint", ml: 473.176473 },
  "sour cream": { unit: "package", grams: 454 },
  yogurt: { unit: "package", grams: 907 },
  "greek yogurt": { unit: "package", grams: 907 },
  "cream cheese": { unit: "package", grams: 227 },
  cheddar: { unit: "bag", grams: 227 },
  mozzarella: { unit: "bag", grams: 227 },
  parmesan: { unit: "package", grams: 142 },
  "all-purpose flour": { unit: "bag", grams: 2268 },
  "bread flour": { unit: "bag", grams: 2268 },
  "whole wheat flour": { unit: "bag", grams: 2268 },
  "granulated sugar": { unit: "bag", grams: 1814 },
  "brown sugar": { unit: "package", grams: 907 },
  "powdered sugar": { unit: "package", grams: 454 },
  salt: { unit: "package", grams: 737 },
  "kosher salt": { unit: "box", grams: 1361 },
  "baking powder": { unit: "can", grams: 227 },
  "baking soda": { unit: "box", grams: 454 },
  cornstarch: { unit: "box", grams: 454 },
  "rolled oats": { unit: "package", grams: 510 },
  "white rice": { unit: "bag", grams: 907 },
  "brown rice": { unit: "bag", grams: 907 },
  spaghetti: { unit: "package", grams: 454 },
  penne: { unit: "package", grams: 454 },
  "olive oil": { unit: "bottle", ml: 500 },
  "vegetable oil": { unit: "bottle", ml: 946 },
  "soy sauce": { unit: "bottle", ml: 296 },
  "vanilla extract": { unit: "bottle", ml: 59 },
  honey: { unit: "bottle", grams: 340 },
  "chicken broth": { unit: "package", ml: 946 },
  "vegetable broth": { unit: "package", ml: 946 },
  "beef broth": { unit: "package", ml: 946 },
  "tomato paste": { unit: "can", grams: 170 },
  "bread crumbs": { unit: "package", grams: 425 },
};

/** Default pack by store section when the ingredient has no entry of its own. */
const CATEGORY_PACKS: Readonly<Record<string, Pack>> = {
  canned: { unit: "can", grams: 411 },
  spices: { unit: "jar", grams: 56 },
};

/** Round up to the next multiple of `step`, guarding float noise (1.3 lb stays 1.5, 1.5 stays 1.5). */
function ceilTo(value: number, step: number): number {
  const steps = value / step;
  const nearest = Math.round(steps);
  const rounded = Math.abs(steps - nearest) < 1e-9 ? nearest : Math.ceil(steps);
  return Math.round(rounded * step * 1e6) / 1e6;
}

const WEIGHTY_CATEGORIES = new Set(["meat", "seafood", "produce"]);
const SIZE_UNITS: ReadonlySet<UnitCode> = new Set<UnitCode>(["small", "medium", "large"]);
const GRAMS_PER_LB = 453.59237;
const GRAMS_PER_OZ = 28.349523125;
/** A pack may fall this far short of the need before we buy another (a 15 oz can for 14.5 oz). */
const PACK_TOLERANCE = 0.05;

/**
 * Round a recipe quantity up to something a person can buy.
 *
 * 1. If the ingredient has a pack size, the answer is a whole number of packs, allowing a
 *    5% shortfall (2 cloves garlic becomes 1 head, 1.5 cups flour becomes 1 bag, a 15 oz
 *    requirement fits one 14.5 oz can).
 * 2. Otherwise weights round up: lb in half-pound steps for meat, seafood, and produce
 *    (1.3 lb becomes 1.5 lb), whole ounces elsewhere.
 * 3. Counts round up to whole items. Volumes round up to a quarter of their unit.
 *
 * Returns null when the unit is unknown or a needed conversion is impossible.
 */
export function toPurchasable(
  qty: number,
  unit: string,
  ingredient: UnitIngredient | null | undefined,
): PurchasableQuantity | null {
  const code = normalizeUnit(unit);
  if (code == null || !Number.isFinite(qty) || qty < 0) return null;
  // A size word describes the item, not how many to buy: 12 large eggs is still 12 eggs.
  const countUnit: UnitCode = SIZE_UNITS.has(code) ? "each" : code;
  if (qty === 0) return { qty: 0, unit: countUnit, basis: "count" };

  const pack = ingredient
    ? (own(PACK_SIZES, ingredient.name) ?? own(CATEGORY_PACKS, ingredient.category))
    : undefined;
  if (ingredient && pack) {
    const packs = packsNeeded(qty, code, ingredient, pack);
    if (packs != null) return { qty: Math.max(1, packs), unit: pack.unit, basis: "pack" };
  }

  const dim = unitDimension(code);
  if (dim === "weight") {
    const grams = qty * (UNIT_DEFS[code].perBase ?? 1);
    if (ingredient && WEIGHTY_CATEGORIES.has(ingredient.category)) {
      const lb = grams / GRAMS_PER_LB;
      if (lb >= 0.5 || code === "lb") return { qty: ceilTo(lb, 0.5), unit: "lb", basis: "weight" };
    }
    const oz = grams / GRAMS_PER_OZ;
    return { qty: ceilTo(oz, 1), unit: "oz", basis: "weight" };
  }
  if (dim === "volume") return { qty: ceilTo(qty, 0.25), unit: code, basis: "volume" };
  return { qty: Math.ceil(qty - 1e-9), unit: countUnit, basis: "count" };
}

function packsNeeded(
  qty: number,
  code: UnitCode,
  ingredient: UnitIngredient,
  pack: Pack,
): number | null {
  let needed: number | null = null;
  if (pack.items != null) {
    // Packs of items (a dozen eggs) count items. Size words do not scale the count.
    const items = convert(qty, SIZE_UNITS.has(code) ? "each" : code, "each", ingredient);
    needed = items == null ? null : items / pack.items;
  } else if (pack.ml != null) {
    needed = convert(qty, code, "ml", ingredient);
    if (needed != null) needed /= pack.ml;
  } else if (pack.grams != null) {
    needed = convert(qty, code, "g", ingredient);
    if (needed != null) needed /= pack.grams;
  }
  if (needed == null || !Number.isFinite(needed)) return null;
  return Math.ceil(needed - PACK_TOLERANCE);
}
