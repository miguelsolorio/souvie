// Store sections and their order (WS05). The default order is docs/03-ai-design.md §6 step 6:
// produce, bakery, meat, seafood, dairy, eggs, pantry, canned, baking, spices, international,
// snacks, frozen, beverages, household, other. A household can reorder its own list, and a store
// can carry its own layout later (keyed by retailer_connections.store_id, WS09 or WS12).
import { INGREDIENT_CATEGORIES } from "../ingredient.ts";

export const DEFAULT_SECTION_ORDER = [
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
] as const;

/** The section an item gets when nothing says otherwise: unparsed lines and manual adds. */
export const FALLBACK_SECTION = "other";

/** Names a person sees for each section. */
export const SECTION_LABELS: Readonly<Record<string, string>> = {
  produce: "Produce",
  bakery: "Bakery",
  meat: "Meat",
  seafood: "Seafood",
  dairy: "Dairy",
  eggs: "Eggs",
  pantry: "Pantry",
  canned: "Canned goods",
  baking: "Baking",
  spices: "Spices",
  international: "International",
  snacks: "Snacks",
  frozen: "Frozen",
  beverages: "Beverages",
  household: "Household",
  other: "Other",
};

/**
 * Per-store layouts, keyed by `retailer_connections.store_id`. Empty for now: no store's real aisle
 * order is known, and inventing one would put items in the wrong place. Add an entry only from a
 * store walk or a retailer source that allows it.
 */
export const STORE_SECTION_ORDERS: Readonly<Record<string, readonly string[]>> = {};

/** The label for a section key. An unknown key (a custom section) is shown as written. */
export function sectionLabel(section: string): string {
  const known = Object.hasOwn(SECTION_LABELS, section) ? SECTION_LABELS[section] : undefined;
  return known ?? section.charAt(0).toUpperCase() + section.slice(1);
}

/**
 * The order to use: `override` first (unknown names kept, repeats dropped), then every default
 * section the override left out, in the default order. With no override, the default order.
 */
export function resolveSectionOrder(override?: readonly string[] | null): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const section of [...(override ?? []), ...DEFAULT_SECTION_ORDER]) {
    if (seen.has(section)) continue;
    seen.add(section);
    order.push(section);
  }
  return order;
}

/**
 * The section order for a list: the household's own, else the store's, else the default.
 * `storeId` is the retailer connection's store id when the list is for one store.
 */
export function sectionOrderFor(args: {
  household?: readonly string[] | null | undefined;
  storeId?: string | null | undefined;
}): string[] {
  const householdOrder = args.household && args.household.length > 0 ? args.household : null;
  const store =
    args.storeId && Object.hasOwn(STORE_SECTION_ORDERS, args.storeId)
      ? STORE_SECTION_ORDERS[args.storeId]
      : undefined;
  return resolveSectionOrder(householdOrder ?? store ?? null);
}

/** Where a section sits in an order. A section the order does not know goes last, before nothing. */
export function sectionIndex(order: readonly string[], section: string): number {
  const index = order.indexOf(section);
  return index === -1 ? order.length : index;
}

export function compareSections(order: readonly string[], a: string, b: string): number {
  return sectionIndex(order, a) - sectionIndex(order, b) || a.localeCompare(b);
}

export interface SectionGroup<T> {
  section: string;
  label: string;
  items: T[];
}

/**
 * Items grouped by section in store order. Sections with no items are left out. Within a section
 * the input order is kept, so sort the items first when a particular order matters.
 */
export function groupBySection<T extends { section: string }>(
  items: readonly T[],
  order: readonly string[] = DEFAULT_SECTION_ORDER,
): SectionGroup<T>[] {
  const bySection = new Map<string, T[]>();
  for (const item of items) {
    const list = bySection.get(item.section);
    if (list) list.push(item);
    else bySection.set(item.section, [item]);
  }
  return [...bySection.keys()]
    .sort((a, b) => compareSections(order, a, b))
    .map((section) => ({
      section,
      label: sectionLabel(section),
      items: bySection.get(section) ?? [],
    }));
}

/** True when `section` is one of the sixteen the app knows. */
export function isKnownSection(section: string): boolean {
  return (INGREDIENT_CATEGORIES as readonly string[]).includes(section);
}
