// How quantities and units read on a list (WS05): "1½ cups", "2 heads", "1.5 lb". Shared by the
// "Why this amount" rules written in `buildList`, the list screens, and the tests, so the words a
// person sees are decided in one place.
import { normalizeUnit, type UnitCode } from "../units.ts";

interface UnitWords {
  one: string;
  many: string;
}

// Units whose written form does not change with the quantity ("1 lb", "2 lb", "3 tsp").
const SYMBOLS: Partial<Record<UnitCode, string>> = {
  tsp: "tsp",
  tbsp: "tbsp",
  fl_oz: "fl oz",
  ml: "ml",
  l: "L",
  g: "g",
  kg: "kg",
  oz: "oz",
  lb: "lb",
  dozen: "dozen",
};

const WORDS: Partial<Record<UnitCode, UnitWords>> = {
  cup: { one: "cup", many: "cups" },
  pint: { one: "pint", many: "pints" },
  quart: { one: "quart", many: "quarts" },
  gallon: { one: "gallon", many: "gallons" },
  pinch: { one: "pinch", many: "pinches" },
  dash: { one: "dash", many: "dashes" },
  drop: { one: "drop", many: "drops" },
  clove: { one: "clove", many: "cloves" },
  head: { one: "head", many: "heads" },
  bunch: { one: "bunch", many: "bunches" },
  can: { one: "can", many: "cans" },
  package: { one: "package", many: "packages" },
  packet: { one: "packet", many: "packets" },
  slice: { one: "slice", many: "slices" },
  stick: { one: "stick", many: "sticks" },
  sprig: { one: "sprig", many: "sprigs" },
  stalk: { one: "stalk", many: "stalks" },
  piece: { one: "piece", many: "pieces" },
  bag: { one: "bag", many: "bags" },
  jar: { one: "jar", many: "jars" },
  bottle: { one: "bottle", many: "bottles" },
  box: { one: "box", many: "boxes" },
  ear: { one: "ear", many: "ears" },
  fillet: { one: "fillet", many: "fillets" },
  sheet: { one: "sheet", many: "sheets" },
  loaf: { one: "loaf", many: "loaves" },
  scoop: { one: "scoop", many: "scoops" },
  handful: { one: "handful", many: "handfuls" },
  block: { one: "block", many: "blocks" },
  carton: { one: "carton", many: "cartons" },
  tub: { one: "tub", many: "tubs" },
  tube: { one: "tube", many: "tubes" },
  container: { one: "container", many: "containers" },
  link: { one: "link", many: "links" },
  rack: { one: "rack", many: "racks" },
  slab: { one: "slab", many: "slabs" },
  recipe: { one: "recipe", many: "recipes" },
  small: { one: "small", many: "small" },
  medium: { one: "medium", many: "medium" },
  large: { one: "large", many: "large" },
};

/**
 * The unit as written for a quantity. "each" is empty ("3", not "3 each"), because a bare number
 * on a list already means that many. A unit the app does not know is shown as it was stored.
 * `qty` null or 1 gives the singular.
 */
export function unitLabel(unit: string | null | undefined, qty: number | null = 1): string {
  if (unit == null || unit.trim() === "") return "";
  const code = normalizeUnit(unit);
  if (code === null) return unit.trim();
  if (code === "each") return "";
  const symbol = SYMBOLS[code];
  if (symbol) return symbol;
  const words = WORDS[code];
  if (!words) return code;
  return qty !== null && Math.abs(qty - 1) > 1e-9 ? words.many : words.one;
}

const FRACTIONS: ReadonlyArray<readonly [number, string]> = [
  [1 / 8, "⅛"],
  [1 / 4, "¼"],
  [1 / 3, "⅓"],
  [1 / 2, "½"],
  [2 / 3, "⅔"],
  [3 / 4, "¾"],
];

/**
 * A quantity for a person: whole numbers as is, common fractions as glyphs ("1½", "⅓"), anything
 * else to two decimals without trailing zeros. 0.3 stays "0.3" rather than a wrong fraction.
 */
export function formatQty(qty: number): string {
  if (!Number.isFinite(qty)) return "";
  const rounded = Math.round(qty * 1000) / 1000;
  const whole = Math.floor(rounded + 1e-9);
  const fraction = rounded - whole;
  if (fraction < 1e-9) return String(whole);
  for (const [value, glyph] of FRACTIONS) {
    if (Math.abs(fraction - value) < 0.005) return whole === 0 ? glyph : `${whole}${glyph}`;
  }
  return String(Math.round(rounded * 100) / 100);
}

/** "1½ cups", "2 heads", "3", "1.5 lb". Null quantity gives an empty string. */
export function formatAmount(qty: number | null, unit: string | null | undefined): string {
  if (qty === null) return "";
  const label = unitLabel(unit, qty);
  return label ? `${formatQty(qty)} ${label}` : formatQty(qty);
}
