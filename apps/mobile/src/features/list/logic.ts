// Display logic for the grocery list screens (WS05). Pure, so it is unit-tested; the components in
// this folder only draw what these functions decide.
import {
  formatAmount,
  type GroceryListItem,
  groupBySection,
  resolveSectionOrder,
  type SectionGroup,
} from "@mp/core";

// ---------------------------------------------------------------------------------------
// Splitting and grouping
// ---------------------------------------------------------------------------------------

export interface ListSplit {
  /** What to buy: not covered by the pantry and not taken off the list. */
  toBuy: GroceryListItem[];
  /** Covered by the pantry (excluded_reason = pantry): the "Already have" group. */
  haveAlready: GroceryListItem[];
  /** Taken off the list by a person (excluded_reason = manual): the "Removed" group. */
  removed: GroceryListItem[];
}

export function splitItems(items: readonly GroceryListItem[]): ListSplit {
  const split: ListSplit = { toBuy: [], haveAlready: [], removed: [] };
  for (const item of items) {
    if (item.excluded_reason === "pantry") split.haveAlready.push(item);
    else if (item.excluded_reason === "manual") split.removed.push(item);
    else split.toBuy.push(item);
  }
  return split;
}

/**
 * Items grouped by section in store order. Within a section, items still to get come first in
 * list order, then the checked ones, so a section shrinks as you shop. `hideChecked` leaves the
 * checked ones out (store mode's "hide done" switch); sections left empty disappear.
 */
export function sectionsToShow(
  items: readonly GroceryListItem[],
  sectionOrder: readonly string[] | null | undefined,
  options: { hideChecked?: boolean } = {},
): SectionGroup<GroceryListItem>[] {
  const order = resolveSectionOrder(sectionOrder);
  const visible = options.hideChecked ? items.filter((item) => !item.checked) : [...items];
  const sorted = visible.sort(
    (a, b) => Number(a.checked) - Number(b.checked) || a.position - b.position,
  );
  return groupBySection(sorted, order);
}

export interface Progress {
  done: number;
  total: number;
  /** 0 to 1; 0 for an empty list. */
  fraction: number;
}

/** How much of what is on the list to buy is checked off. */
export function progressOf(toBuy: readonly Pick<GroceryListItem, "checked">[]): Progress {
  const total = toBuy.length;
  const done = toBuy.filter((item) => item.checked).length;
  return { done, total, fraction: total === 0 ? 0 : done / total };
}

/** The order with `section` moved one place up (-1) or down (1). At either end, unchanged. */
export function moveSection(
  order: readonly string[],
  section: string,
  direction: -1 | 1,
): string[] {
  const next = [...order];
  const from = next.indexOf(section);
  const to = from + direction;
  if (from === -1 || to < 0 || to >= next.length) return next;
  const [moved] = next.splice(from, 1);
  if (moved !== undefined) next.splice(to, 0, moved);
  return next;
}

// ---------------------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------------------

/** "2 cups", "3", "1½ lb"; empty when the item has no amount ("salt to taste"). */
export function amountLabel(item: Pick<GroceryListItem, "qty" | "unit">): string {
  return formatAmount(item.qty, item.unit);
}

/** What a screen reader says for a row: "Yellow onion, 3, needs a look, checked". */
export function rowAccessibilityLabel(item: GroceryListItem): string {
  const parts = [item.display_name];
  const amount = amountLabel(item);
  if (amount) parts.push(amount);
  if (item.needs_attention) parts.push("needs a look");
  return parts.join(", ");
}

/** Why an item carries the "needs a look" mark, or null when it does not. */
export function attentionNote(item: GroceryListItem): string | null {
  if (!item.needs_attention) return null;
  switch (item.detail.attention) {
    case "unparsed":
      return "We could not match this line to an ingredient, so it is listed the way the recipe wrote it. Check the amount yourself.";
    case "mixed_units":
      return "This ingredient is measured in units that cannot be added together (for example cups and whole items), so each amount is its own line.";
    case "unknown_unit":
      return "We do not know this unit, so the amount is shown as the recipe wrote it.";
    default:
      return "Check this one before you shop.";
  }
}

export interface ContributionRow {
  key: string;
  recipe: string;
  /** "4 servings (the recipe makes 2)". */
  servings: string;
  /** "1½ cups", or "No amount" for a line such as "to taste". */
  amount: string;
  /** The recipe's own words for the lines. */
  lines: string[];
  note: string | null;
  optional: boolean;
}

function servingsText(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return `${rounded} ${rounded === 1 ? "serving" : "servings"}`;
}

/** One row per recipe entry that adds to the item, for the "Why this amount" sheet. */
export function contributionRows(item: GroceryListItem): ContributionRow[] {
  return item.detail.contributions.map((contribution, index) => {
    const makes = contribution.recipeServings;
    const differs = makes != null && Math.abs(makes - contribution.servings) > 1e-9;
    return {
      key: `${contribution.entryId}:${index}`,
      recipe: contribution.recipeTitle,
      servings: differs
        ? `${servingsText(contribution.servings)} (the recipe makes ${Math.round(makes * 100) / 100})`
        : servingsText(contribution.servings),
      amount:
        contribution.qty === null
          ? "No amount"
          : formatAmount(contribution.qty, contribution.unit) || String(contribution.qty),
      lines: contribution.rawTexts,
      note: contribution.note ?? null,
      optional: contribution.optional === true,
    };
  });
}

/**
 * The rounding step in a sentence: "Added up: 12 cloves. Round up to whole heads: 2 heads."
 * Null when the amount was used as added up.
 */
export function roundingSentence(item: GroceryListItem): string | null {
  const rounding = item.detail.rounding;
  if (!rounding) return null;
  const from = formatAmount(rounding.from, rounding.fromUnit) || String(rounding.from);
  const to = formatAmount(rounding.to, rounding.toUnit) || String(rounding.to);
  const rule = rounding.rule.charAt(0).toUpperCase() + rounding.rule.slice(1);
  return `Added up: ${from}. ${rule}: ${to}.`;
}

/** The line under the item's name in the sheet: "You need 2 heads". */
export function needSummary(item: GroceryListItem): string {
  const amount = amountLabel(item);
  if (item.is_manual) return amount ? `You added this: ${amount}` : "You added this item.";
  return amount ? `You need ${amount}` : "No amount: buy some";
}

/** "3 changes saved on this device, waiting to sync." Null when nothing is waiting. */
export function syncNote(pending: number): string | null {
  if (pending <= 0) return null;
  return `${pending} ${pending === 1 ? "change" : "changes"} saved on this device, waiting to sync.`;
}

// ---------------------------------------------------------------------------------------
// Typing an amount
// ---------------------------------------------------------------------------------------

const VULGAR: Readonly<Record<string, number>> = {
  "¼": 0.25,
  "½": 0.5,
  "¾": 0.75,
  "⅓": 1 / 3,
  "⅔": 2 / 3,
  "⅛": 0.125,
};

/**
 * Reads an amount a person typed: "2", "1.5", "1/2", "1 1/2", "1½", "½". Empty is null (no
 * amount). Anything else, or zero or less, is "invalid".
 */
export function parseQuantityInput(text: string): number | null | "invalid" {
  const raw = text.trim();
  if (raw === "") return null;
  const glyph = /^(\d+)?\s*([¼½¾⅓⅔⅛])$/.exec(raw);
  if (glyph) {
    const whole = glyph[1] ? Number(glyph[1]) : 0;
    return whole + (VULGAR[glyph[2] ?? ""] ?? 0);
  }
  const mixed = /^(\d+)\s+(\d+)\/(\d+)$/.exec(raw);
  if (mixed) {
    const denominator = Number(mixed[3]);
    if (denominator === 0) return "invalid";
    const value = Number(mixed[1]) + Number(mixed[2]) / denominator;
    return value > 0 ? value : "invalid";
  }
  const fraction = /^(\d+)\/(\d+)$/.exec(raw);
  if (fraction) {
    const denominator = Number(fraction[2]);
    if (denominator === 0) return "invalid";
    const value = Number(fraction[1]) / denominator;
    return value > 0 ? value : "invalid";
  }
  if (/^\d*\.?\d+$/.test(raw)) {
    const value = Number(raw);
    return value > 0 && value <= 1_000_000 ? value : "invalid";
  }
  return "invalid";
}

/** The text field's starting value for an amount: "1.5", empty for none. */
export function quantityInputText(qty: number | null): string {
  if (qty === null) return "";
  return String(Math.round(qty * 1000) / 1000);
}

/** The unit as a person types it ("cups"), or null when empty. Letters, spaces and a dot only. */
export function parseUnitInput(text: string): string | null | "invalid" {
  const raw = text.trim();
  if (raw === "") return null;
  if (raw.length > 40 || !/^[A-Za-z][A-Za-z .]*$/.test(raw)) return "invalid";
  return raw;
}
