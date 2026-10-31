// Containers on an ingredient line (WS05, orchestrator correction 3). "2 (14 oz) cans diced
// tomatoes" means two cans, not 28 oz of tomatoes. If the list only kept 28 oz, rounding to cans
// by weight would guess a can size (the canned default is 14.5 oz) and could buy three cans, and
// "1 (28 oz) can" would buy two (WS03 review, 2026-10-30).
//
// A line says it in one of two ways:
//   * the columns `container_count` and `container` on recipe_ingredients (CCR5), which the
//     parser will fill (a WS03 follow-up), or
//   * only its raw text, until then: "2 (14 oz) cans ..." or "2 cans (14 oz each) ...".
// `containerOf` reads the columns first and the raw text second.
import { normalizeUnit, type UnitCode, unitDimension } from "../units.ts";
import type { ListIngredientLine } from "./types.ts";

/** A container size: the contents of one can, jar, or bag. */
export interface ContainerSize {
  qty: number;
  unit: UnitCode;
}

export interface ContainerInfo {
  /** How many containers the line names. */
  count: number;
  /** The container as a unit code: can, jar, package, bag. */
  container: UnitCode;
  /** The contents of one container, when the line says. */
  size: ContainerSize | null;
}

/** Units that name a container rather than an amount of food. */
const CONTAINER_UNITS: ReadonlySet<UnitCode> = new Set<UnitCode>([
  "can",
  "jar",
  "package",
  "packet",
  "bag",
  "box",
  "bottle",
  "carton",
  "tub",
  "tube",
  "container",
]);

export function isContainerUnit(unit: string | null | undefined): boolean {
  const code = normalizeUnit(unit);
  return code !== null && CONTAINER_UNITS.has(code);
}

const WORD =
  "(cans?|tins?|jars?|packages?|pkgs?|packs?|packets?|bags?|boxes|box|bottles?|cartons?|containers?|tubs?|tubes?)";
// The lookahead keeps a unit from matching the first letter of a word: the "l" in "large".
const SIZE_UNIT =
  "(fl\\.?\\s*oz|fluid\\s+ounces?|ounces?|oz|pounds?|lbs?|grams?|g|kilograms?|kg|milliliters?|ml|liters?|l)(?![a-z])\\.?";
const NUMBER = "(\\d+(?:\\.\\d+)?)";
const COUNT_WORD = "(?:(\\d+)|an?|one)";

// "2 (14 oz) cans", "1 (28-ounce) can", "2 (14.5 oz.) cans"
const SIZE_BEFORE_WORD = new RegExp(
  `^\\s*${COUNT_WORD}\\s*\\(\\s*${NUMBER}[\\s-]*${SIZE_UNIT}\\s*\\)\\s*${WORD}\\b`,
  "i",
);
// "1 14-ounce can", "2 15 oz cans" (the size without parentheses)
const BARE_SIZE_BEFORE_WORD = new RegExp(
  `^\\s*${COUNT_WORD}\\s+${NUMBER}[\\s-]*${SIZE_UNIT}\\s+${WORD}\\b`,
  "i",
);
// "2 cans (14 oz each)", "1 can (28 oz)", "2 cans, 14 oz each"
const SIZE_AFTER_WORD = new RegExp(
  `^\\s*${COUNT_WORD}\\s*${WORD}\\s*[,(]?\\s*${NUMBER}[\\s-]*${SIZE_UNIT}\\s*(?:each\\s*)?\\)?`,
  "i",
);

function positiveInt(text: string | undefined): number {
  if (text === undefined) return 1;
  const n = Number(text);
  return Number.isInteger(n) && n > 0 ? n : Number.NaN;
}

function sizeOf(qtyText: string | undefined, unitText: string | undefined): ContainerSize | null {
  const qty = Number(qtyText);
  const unit = normalizeUnit(unitText?.replace(/\s+/g, " "));
  if (!Number.isFinite(qty) || qty <= 0 || unit === null) return null;
  return unitDimension(unit) === "count" ? null : { qty, unit };
}

/**
 * The container a line's raw text names, or null. Reads the two shapes the WS03 review named,
 * plus their common variants. It does not look at a quantity range, a fraction ("1/2 (14 oz)
 * can"), or any line that does not start with the count: those stay plain lines.
 */
export function detectContainer(rawText: string): ContainerInfo | null {
  const text = rawText.replace(/[‐-―−]/g, "-");
  for (const [pattern, wordAt, qtyAt, unitAt] of [
    [SIZE_BEFORE_WORD, 4, 2, 3],
    [BARE_SIZE_BEFORE_WORD, 4, 2, 3],
    [SIZE_AFTER_WORD, 2, 3, 4],
  ] as const) {
    const match = pattern.exec(text);
    if (!match) continue;
    const count = positiveInt(match[1]);
    const container = normalizeUnit(match[wordAt]);
    if (!Number.isFinite(count) || container === null || !CONTAINER_UNITS.has(container)) continue;
    return { count, container, size: sizeOf(match[qtyAt], match[unitAt]) };
  }
  return null;
}

/** Within 1 percent, so 28 vs 28.0000001 from float noise agrees. */
function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * 0.01);
}

/**
 * The containers a line names, as the list uses them, or null for a plain line.
 *
 *   columns   container_count and container are set: the count and word come from them. The size
 *             is the parsed total divided by the count when the total is a weight or a volume
 *             ("28 oz" over 2 cans), else the raw text's size if it states one.
 *   raw text  detectContainer finds the count, word and size. It applies only when the parsed
 *             quantity agrees: the container itself ("2 can") or the total contents (28 oz), so a
 *             surprising parse is never reinterpreted.
 */
export function containerOf(line: ListIngredientLine): ContainerInfo | null {
  const parsedUnit = normalizeUnit(line.unit);
  const fromText = detectContainer(line.raw_text);

  const columnCount = line.container_count ?? null;
  const columnWord = normalizeUnit(line.container);
  if (columnCount !== null && columnCount > 0 && columnWord !== null) {
    let size: ContainerSize | null = null;
    if (
      parsedUnit !== null &&
      line.qty !== null &&
      line.qty > 0 &&
      unitDimension(parsedUnit) !== "count"
    ) {
      size = { qty: line.qty / columnCount, unit: parsedUnit };
    } else if (fromText?.size) {
      size = fromText.size;
    }
    return { count: columnCount, container: columnWord, size };
  }

  if (!fromText) return null;
  if (line.qty === null || parsedUnit === null) return fromText;
  const qty = line.qty;
  // "2 cans (14 oz each)" parsed as 2 can.
  if (parsedUnit === fromText.container && near(qty, fromText.count)) return fromText;
  // "2 (14 oz) cans" parsed as 28 oz.
  if (fromText.size && parsedUnit === fromText.size.unit) {
    return near(qty, fromText.count * fromText.size.qty) ? fromText : null;
  }
  return null;
}
