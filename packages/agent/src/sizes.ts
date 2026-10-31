// How many units of a product cover a list line (docs/03-ai-design.md §7, "unit-price fit for the
// required quantity"). Pure functions over @mp/core's unit table.
//
// A list line is already rounded to something buyable by list-build (1.5 lb chicken, 2 cans
// tomatoes, 1 head garlic). A product's size is the retailer's text ("3 lb bag", "12 ct",
// "1/2 gal", "16.9 fl oz"). The answer is a whole number of units for the cart, and whether the
// sizes could be compared at all.
import {
  convert,
  detectContainer,
  isContainerUnit,
  normalizeUnit,
  type UnitCode,
  unitDimension,
} from "@mp/core";
import type { Product } from "@mp/retailers";
import type { ListLine } from "./types.ts";

/** One retail unit's contents. */
export interface PackSize {
  qty: number;
  unit: UnitCode;
}

/** The most units of one product a single line may buy. */
export const MAX_UNITS_PER_LINE = 24;

const COUNT_WORDS: Readonly<Record<string, UnitCode>> = {
  ct: "each",
  count: "each",
  pk: "each",
  pc: "each",
  pcs: "each",
};

const SIZE_PATTERN = /(\d+(?:\.\d+)?(?:\s*\/\s*\d+)?)\s*(fl\.?\s*oz|fluid ounces?|[a-z]+)\.?/i;

function number(text: string): number {
  const [top, bottom] = text.split("/").map((part) => Number(part.trim()));
  if (bottom !== undefined) return top !== undefined && bottom > 0 ? top / bottom : Number.NaN;
  return top ?? Number.NaN;
}

/** "3 lb bag" -> 3 lb, "12 ct" -> 12 each, "1/2 gal" -> 0.5 gallon, "per lb" -> 1 lb. */
export function parsePackSize(size: string | null | undefined): PackSize | null {
  if (!size) return null;
  const text = size.trim().toLowerCase();
  const per = /^(per|\/)\s*([a-z]+)/.exec(text);
  if (per?.[2]) {
    const unit = normalizeUnit(per[2]);
    return unit ? { qty: 1, unit } : null;
  }
  const match = SIZE_PATTERN.exec(text);
  if (!match?.[1] || !match[2]) return null;
  const qty = number(match[1]);
  const word = match[2].replace(/\s+/g, " ");
  const unit = COUNT_WORDS[word] ?? normalizeUnit(word);
  if (!unit || !Number.isFinite(qty) || qty <= 0) return null;
  return { qty, unit };
}

/** The container size the recipe lines name ("2 (14 oz) cans"), when they all agree. */
export function containerSizeHint(rawTexts: readonly string[]): PackSize | null {
  let found: PackSize | null = null;
  for (const raw of rawTexts) {
    const info = detectContainer(raw);
    if (!info?.size) continue;
    if (found && (found.unit !== info.size.unit || Math.abs(found.qty - info.size.qty) > 1e-6)) {
      return null;
    }
    found = { qty: info.size.qty, unit: info.size.unit };
  }
  return found;
}

export interface BuyPlan {
  /** Whole units for the cart, 1 to MAX_UNITS_PER_LINE. */
  units: number;
  /** True when the line's amount and the product's size could be compared. */
  known: boolean;
  /** Units times pack size over what the line needs: 1 is exact, 2 is double. Null if unknown. */
  coverage: number | null;
}

function clampUnits(units: number): number {
  if (!Number.isFinite(units)) return 1;
  return Math.min(MAX_UNITS_PER_LINE, Math.max(1, Math.ceil(units - 0.02)));
}

/** Converts `qty` of `from` into `to` for this line's ingredient, or null. */
function convertFor(line: ListLine, qty: number, from: UnitCode, to: UnitCode): number | null {
  if (from === to) return qty;
  return convert(qty, from, to, line.ingredient);
}

/**
 * Units of `product` that cover `line`. When the sizes cannot be compared the answer is the line's
 * own count (or 1) and `known` is false; the scorer treats that as an unknown fit.
 */
export function unitsToBuy(
  line: Pick<ListLine, "qty" | "unit" | "rawTexts" | "ingredient">,
  product: Pick<Product, "size">,
): BuyPlan {
  const qty = line.qty;
  const lineUnit = normalizeUnit(line.unit);
  const pack = parsePackSize(product.size);
  const fullLine = line as ListLine;

  if (qty === null || qty <= 0 || lineUnit === null) {
    return { units: 1, known: false, coverage: null };
  }

  // A line counted in containers ("2 can"): use the recipes' container size when they name one,
  // else one product per container.
  if (isContainerUnit(lineUnit)) {
    const hint = containerSizeHint(line.rawTexts);
    if (hint && pack && unitDimension(pack.unit) !== "count") {
      const needed = convertFor(fullLine, qty * hint.qty, hint.unit, pack.unit);
      if (needed !== null && needed > 0) {
        const units = clampUnits(needed / pack.qty);
        return { units, known: true, coverage: (units * pack.qty) / needed };
      }
    }
    return { units: clampUnits(qty), known: pack !== null, coverage: pack ? 1 : null };
  }

  if (!pack) {
    return {
      units: unitDimension(lineUnit) === "count" ? clampUnits(qty) : 1,
      known: false,
      coverage: null,
    };
  }

  // Count against count: "1 head" garlic and "3 ct" garlic are the same things counted.
  if (unitDimension(lineUnit) === "count" && unitDimension(pack.unit) === "count") {
    const sameThing = pack.unit === "each" || pack.unit === lineUnit;
    if (sameThing) {
      const units = clampUnits(qty / pack.qty);
      return { units, known: true, coverage: (units * pack.qty) / qty };
    }
  }

  const needed = convertFor(fullLine, qty, lineUnit, pack.unit);
  if (needed === null || needed <= 0) {
    return {
      units: unitDimension(lineUnit) === "count" ? clampUnits(qty) : 1,
      known: false,
      coverage: null,
    };
  }
  const units = clampUnits(needed / pack.qty);
  return { units, known: true, coverage: (units * pack.qty) / needed };
}

/** True when the product's size is within 15 percent of the recipes' container size. */
export function matchesContainerHint(
  line: Pick<ListLine, "rawTexts" | "ingredient">,
  product: Pick<Product, "size">,
): boolean {
  const hint = containerSizeHint(line.rawTexts);
  const pack = parsePackSize(product.size);
  if (!hint || !pack) return false;
  const same = convertFor(line as ListLine, hint.qty, hint.unit, pack.unit);
  return same !== null && Math.abs(same - pack.qty) <= same * 0.15;
}
