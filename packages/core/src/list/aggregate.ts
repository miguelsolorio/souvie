// List aggregation (WS05, docs/03-ai-design.md §6). `buildList` turns a week's plan into one
// grocery list: it scales every recipe line to the servings planned, adds up lines per ingredient,
// leaves out what the pantry covers, rounds to amounts a person can buy, and orders the result by
// store section.
//
// Pure. No clock, no randomness, no I/O: the same input gives the same list, so every bug a person
// reports becomes a fixture (src/list/fixtures) and a test. Unit conversion is the main correctness
// risk (R2), so the contributions behind every number are kept and shown ("Why this amount").
//
// What counts as a need:
//   * entries that are planned or cooked; a skipped entry buys nothing
//   * every line of the recipe, optional ones included (a missing item in the store is worse than
//     an extra one); the contribution says when all of an entry's lines were optional
//   * the line's upper bound when it gives a range, so the list never comes up short
//
// What it never does:
//   * drop a line. A line it cannot place becomes an item named by its raw text with the
//     needs-attention flag, or a separate item for the amount it could not add in
//   * merge a qualified line into an unqualified one ("gluten-free pasta" never joins "pasta")
//   * round a known container count up into more containers (qualifiers.ts and containers.ts
//     explain why)
import type { Ingredient } from "../ingredient.ts";
import {
  convert,
  normalizeUnit,
  toPurchasable,
  type UnitCode,
  type UnitIngredient,
  unitDimension,
} from "../units.ts";
import {
  type ContainerInfo,
  type ContainerSize,
  containerOf,
  isContainerUnit,
} from "./containers.ts";
import { unitLabel } from "./format.ts";
import { extractQualifiers, withQualifiers } from "./qualifiers.ts";
import { compareSections, FALLBACK_SECTION, resolveSectionOrder } from "./sections.ts";
import { sha256Hex } from "./sha256.ts";
import type {
  AttentionReason,
  BuildListOptions,
  Contribution,
  DraftItem,
  GroceryListDraft,
  ListEntry,
  ListIngredientLine,
  ListRecipe,
  PantryEntry,
  Rounding,
  SkippedReason,
} from "./types.ts";

export interface BuildListInput {
  entries: readonly ListEntry[];
  recipes: readonly ListRecipe[];
  ingredients: ReadonlyMap<string, Ingredient>;
  pantry: readonly PantryEntry[];
  options?: BuildListOptions;
}

// ---------------------------------------------------------------------------------------
// The plan fingerprint
// ---------------------------------------------------------------------------------------

/** What the fingerprint reads of an entry. Servings may arrive as a string from a numeric column. */
export interface FingerprintEntry {
  id: string;
  recipe_id: string;
  servings: number | string;
  status: string;
}

/**
 * SHA-256 over the plan's entries as sorted `(id, recipe_id, servings, status)` tuples
 * (orchestrator correction 5, 2026-10-30). `meal_plans` has no version counter and a deleted entry
 * leaves no `updated_at` trace, so the list stores this at build time and a phone recomputes it from
 * the entries it holds: a difference means the plan changed since the list was built.
 *
 * Servings go through Number, so "4", 4 and "4.0" agree between the database and a phone.
 */
export function planFingerprint(entries: readonly FingerprintEntry[]): string {
  const tuples = entries.map(
    (entry) => `${entry.id}|${entry.recipe_id}|${Number(entry.servings)}|${entry.status}`,
  );
  tuples.sort();
  return sha256Hex(tuples.join("\n"));
}

// ---------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------

const SLOT_ORDER: Readonly<Record<string, number>> = {
  breakfast: 0,
  lunch: 1,
  dinner: 2,
  snack: 3,
};

/** Locale-free, so the order is the same on the server and on every phone. */
function compareText(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
}

/** Entries in the order a week reads: day, slot, position, then id. */
function sortEntries<T extends ListEntry>(entries: readonly T[]): T[] {
  return [...entries].sort(
    (a, b) =>
      compareText(a.date, b.date) ||
      (SLOT_ORDER[a.slot] ?? 9) - (SLOT_ORDER[b.slot] ?? 9) ||
      a.position - b.position ||
      compareText(a.id, b.id),
  );
}

/** Rounds away float noise from unit conversion (1.2000000000000002) without losing real digits. */
function tidy(value: number, places = 4): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-6;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const SIZE_WORDS: ReadonlySet<UnitCode> = new Set<UnitCode>(["small", "medium", "large"]);

// ---------------------------------------------------------------------------------------
// Sources: one per recipe line per planned entry
// ---------------------------------------------------------------------------------------

interface Source {
  entry: ListEntry;
  recipe: ListRecipe;
  line: ListIngredientLine;
  /** entry.servings / recipe.servings, or 1 when the recipe does not say what it makes. */
  factor: number;
  factorKnown: boolean;
  /** The scaled quantity: a count of containers for a container line. Null for "to taste". */
  qty: number | null;
  /** The unit the quantity is in. Null when the line gave a unit the app does not know. */
  unit: UnitCode | null;
  rawUnit: string | null;
  container: ContainerInfo | null;
}

function makeSource(
  entry: ListEntry,
  recipe: ListRecipe,
  line: ListIngredientLine,
  factor: number,
  factorKnown: boolean,
): Source {
  const rawUnit = line.unit?.trim() ? line.unit.trim() : null;
  const container = containerOf(line);
  let qty: number | null;
  let unit: UnitCode | null;
  if (container) {
    qty = container.count * factor;
    unit = container.container;
  } else {
    // The upper bound of a range, so the list never comes up short (WS03 report).
    const base =
      line.qty_max != null && line.qty != null
        ? Math.max(line.qty, line.qty_max)
        : (line.qty_max ?? line.qty);
    qty = base === null || base === undefined ? null : base * factor;
    const code = normalizeUnit(rawUnit);
    // A size word describes the item, not how many to buy (units.ts): 2 large onions are 2 onions.
    unit = code !== null && SIZE_WORDS.has(code) ? "each" : code;
    // A bare number is a count: "3 carrots".
    if (qty !== null && unit === null && rawUnit === null) unit = "each";
  }
  return { entry, recipe, line, factor, factorKnown, qty, unit, rawUnit, container };
}

// ---------------------------------------------------------------------------------------
// Converting a source into a working unit
// ---------------------------------------------------------------------------------------

interface GroupContext {
  ingredient: Ingredient & UnitIngredient;
  /** The one container size every sized container line agrees on, for turning weights into cans. */
  uniformSize: ContainerSize | null;
  /** The container unit those lines share. */
  containerUnit: UnitCode | null;
}

function groupContext(ingredient: Ingredient, sources: readonly Source[]): GroupContext {
  const sized = sources.filter((s) => s.container?.size);
  const first = sized[0]?.container;
  const sameSize =
    first?.size &&
    sized.every(
      (s) =>
        s.container?.container === first.container &&
        s.container.size?.unit === first.size?.unit &&
        near(s.container.size?.qty ?? 0, first.size?.qty ?? -1),
    );
  return {
    ingredient,
    uniformSize: sameSize && first?.size ? first.size : null,
    containerUnit: sameSize && first ? first.container : null,
  };
}

/** `source`'s quantity expressed in `target`, or null when the ingredient cannot bridge the two. */
function toUnit(source: Source, target: UnitCode, ctx: GroupContext): number | null {
  if (source.qty === null || source.unit === null) return null;
  if (source.unit === target) return source.qty;
  const size = source.container?.size;
  if (size) {
    // Two 14 oz cans are 28 oz of contents, whatever a "can" weighs by default.
    return convert(source.qty * size.qty, size.unit, target, ctx.ingredient);
  }
  if (ctx.uniformSize && target === ctx.containerUnit && unitDimension(source.unit) !== "count") {
    const inSizeUnit = convert(source.qty, source.unit, ctx.uniformSize.unit, ctx.ingredient);
    return inSizeUnit === null ? null : inSizeUnit / ctx.uniformSize.qty;
  }
  return convert(source.qty, source.unit, target, ctx.ingredient);
}

interface Partition {
  unit: UnitCode;
  sources: Source[];
}

/**
 * Splits quantified sources into groups that can be added together, each with its working unit.
 * One group in the common case. The unit is the sources' own when they all agree; otherwise the
 * ingredient's default unit, else the first unit every source converts to. Sources that no unit
 * can join (2 cups and 3 each of an onion with no density) form further groups, in order, and
 * the caller flags them.
 */
function partition(quantified: readonly Source[], ctx: GroupContext): Partition[] {
  if (quantified.length === 0) return [];
  const distinct: UnitCode[] = [];
  for (const source of quantified) {
    if (source.unit !== null && !distinct.includes(source.unit)) distinct.push(source.unit);
  }
  let candidates = distinct;
  if (distinct.length > 1) {
    const preferred = normalizeUnit(ctx.ingredient.defaultUnit);
    const asUnit = preferred !== null && SIZE_WORDS.has(preferred) ? "each" : preferred;
    candidates = asUnit ? [asUnit, ...distinct.filter((unit) => unit !== asUnit)] : distinct;
  }
  for (const unit of candidates) {
    if (quantified.every((source) => toUnit(source, unit, ctx) !== null)) {
      return [{ unit, sources: [...quantified] }];
    }
  }

  const groups: Partition[] = [];
  let remaining = [...quantified];
  while (remaining.length > 0) {
    const anchor = remaining[0];
    if (!anchor || anchor.unit === null) break;
    const unit = anchor.unit;
    const members = remaining.filter((source) => toUnit(source, unit, ctx) !== null);
    groups.push({ unit, sources: members });
    remaining = remaining.filter((source) => !members.includes(source));
  }
  return groups;
}

// ---------------------------------------------------------------------------------------
// Rounding
// ---------------------------------------------------------------------------------------

function plural(unit: string): string {
  return unitLabel(unit, 2) || "units";
}

function roundingRule(basis: string, from: number, to: number, toUnit: string): string {
  switch (basis) {
    case "container":
      return near(from, to)
        ? `kept at the ${plural(toUnit)} the recipes name`
        : `round up to whole ${plural(toUnit)}`;
    case "pack":
      return `round up to whole ${plural(toUnit)}`;
    case "weight":
      return toUnit === "lb" ? "round up to the next half pound" : "round up to a whole ounce";
    case "volume":
      return `round up to a multiple of ¼ ${unitLabel(toUnit, 1)}`;
    default:
      return "round up to whole units";
  }
}

// ---------------------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------------------

/** An item before its section position and pantry decision. */
type PartialItem = Omit<DraftItem, "position" | "excludedReason">;

function contributionsOf(
  sources: readonly Source[],
  amountOf: (source: Source) => number | null,
  unit: string | null,
): Contribution[] {
  interface Share {
    first: Source;
    total: number | null;
    rawTexts: string[];
    allOptional: boolean;
  }
  const byEntry = new Map<string, Share>();
  for (const source of sources) {
    const amount = amountOf(source);
    let share = byEntry.get(source.entry.id);
    if (!share) {
      share = { first: source, total: null, rawTexts: [], allOptional: true };
      byEntry.set(source.entry.id, share);
    }
    if (amount !== null) share.total = (share.total ?? 0) + amount;
    share.rawTexts.push(source.line.raw_text);
    if (!source.line.optional) share.allOptional = false;
  }
  return [...byEntry.values()].map((share) => {
    const { entry, recipe, factorKnown } = share.first;
    const contribution: Contribution = {
      entryId: entry.id,
      recipeTitle: recipe.title,
      servings: entry.servings,
      recipeServings: recipe.servings ?? null,
      qty: share.total === null ? null : tidy(share.total),
      unit: share.total === null ? null : unit,
      rawTexts: share.rawTexts,
    };
    if (share.allOptional) contribution.optional = true;
    if (!factorKnown)
      contribution.note =
        "The recipe does not say how many it serves, so its amounts are used as written.";
    return contribution;
  });
}

function uniqueEntryIds(sources: readonly Source[]): string[] {
  const ids: string[] = [];
  for (const source of sources) if (!ids.includes(source.entry.id)) ids.push(source.entry.id);
  return ids;
}

/**
 * Adds up one ingredient's lines (one qualifier set) into one item, or more when some amounts
 * cannot be added together. The rounding step is recorded on the item.
 */
function aggregateGroup(
  ingredient: Ingredient,
  qualifiers: readonly string[],
  sources: readonly Source[],
  roundUp: boolean,
): PartialItem[] {
  const ctx = groupContext(ingredient, sources);
  const quantified = sources.filter((s) => s.qty !== null && s.unit !== null);
  const unknownUnit = sources.filter((s) => s.qty !== null && s.unit === null);
  const unquantified = sources.filter((s) => s.qty === null);
  const partitions = partition(quantified, ctx);

  // Amounts in a unit the app does not know are never added to anything else.
  const unknownGroups = new Map<string, Source[]>();
  for (const source of unknownUnit) {
    const key = (source.rawUnit ?? "").toLowerCase();
    const list = unknownGroups.get(key);
    if (list) list.push(source);
    else unknownGroups.set(key, [source]);
  }

  const split = partitions.length + unknownGroups.size > 1;
  const displayName = withQualifiers(capitalize(ingredient.name), qualifiers);
  const section = ingredient.category;
  const items: PartialItem[] = [];

  for (const [index, part] of partitions.entries()) {
    const members = index === 0 ? [...part.sources, ...unquantified] : [...part.sources];
    // Contributions keep the plan's order even when "to taste" lines are mixed in.
    members.sort((a, b) => sources.indexOf(a) - sources.indexOf(b));
    const amountOf = (source: Source) => toUnit(source, part.unit, ctx);
    const total = tidy(
      part.sources.reduce((sum, source) => sum + (amountOf(source) ?? 0), 0),
      6,
    );

    let qty = total;
    let unit: string = part.unit;
    let rounding: Rounding | undefined;
    if (roundUp) {
      const containerBased =
        isContainerUnit(part.unit) && part.sources.some((source) => source.container !== null);
      const purchasable = toPurchasable(
        total,
        part.unit,
        ingredient,
        containerBased ? { count: total, container: part.unit } : null,
      );
      if (purchasable) {
        qty = purchasable.qty;
        unit = purchasable.unit;
        // A rounding step is recorded only when the amount changed. 1 lb shown as 16 oz, or 12
        // eggs as 1 dozen, is a different unit for the same amount: nothing was rounded.
        let changed: boolean;
        if (purchasable.unit === part.unit) changed = !near(purchasable.qty, total);
        else {
          const back = convert(purchasable.qty, purchasable.unit, part.unit, ingredient);
          // A pack of unknown weight cannot be shown to equal the amount, so it counts as changed.
          changed = back === null || Math.abs(back - total) > 1e-6 * Math.max(1, Math.abs(total));
        }
        if (changed) {
          rounding = {
            from: tidy(total, 3),
            fromUnit: part.unit,
            to: purchasable.qty,
            toUnit: purchasable.unit,
            rule: roundingRule(purchasable.basis, total, purchasable.qty, purchasable.unit),
          };
        }
      }
    }

    items.push({
      ingredientId: ingredient.id,
      displayName,
      qty: tidy(qty),
      unit,
      sourceEntryIds: uniqueEntryIds(members),
      section,
      qualifiers: [...qualifiers],
      contributions: contributionsOf(members, amountOf, part.unit),
      ...(rounding ? { rounding } : {}),
      needsAttention: split,
      ...(split ? { attention: "mixed_units" as AttentionReason } : {}),
    });
  }

  for (const members of unknownGroups.values()) {
    const rawUnit = (members[0]?.rawUnit ?? "").slice(0, 40);
    const amountOf = (source: Source) => source.qty;
    const total = tidy(members.reduce((sum, source) => sum + (source.qty ?? 0), 0));
    items.push({
      ingredientId: ingredient.id,
      displayName,
      qty: total,
      unit: rawUnit,
      sourceEntryIds: uniqueEntryIds(members),
      section,
      qualifiers: [...qualifiers],
      contributions: contributionsOf(members, amountOf, rawUnit),
      needsAttention: true,
      attention: "unknown_unit",
    });
  }

  if (items.length === 0) {
    // Only "to taste" lines: the item says what to buy and not how much.
    items.push({
      ingredientId: ingredient.id,
      displayName,
      qty: null,
      unit: null,
      sourceEntryIds: uniqueEntryIds(unquantified),
      section,
      qualifiers: [...qualifiers],
      contributions: contributionsOf(unquantified, () => null, null),
      needsAttention: false,
    });
  }
  return items;
}

/** One item for a recipe line the ontology could not place. Never dropped (brief, "Risks"). */
function unparsedItem(sources: readonly Source[]): PartialItem {
  const first = sources[0] as Source;
  const scaled = sources.some((source) => source.factor !== 1);
  const contributions = contributionsOf(sources, () => null, null).map((contribution) =>
    scaled
      ? {
          ...contribution,
          note: contribution.note ?? "Not scaled: the amount is part of the line.",
        }
      : contribution,
  );
  return {
    ingredientId: null,
    displayName: first.line.raw_text.trim().slice(0, 500) || "Unnamed item",
    qty: null,
    unit: null,
    sourceEntryIds: uniqueEntryIds(sources),
    section: FALLBACK_SECTION,
    qualifiers: [],
    contributions,
    needsAttention: true,
    attention: "unparsed",
  };
}

// ---------------------------------------------------------------------------------------
// buildList
// ---------------------------------------------------------------------------------------

export function buildList(input: BuildListInput): GroceryListDraft {
  const { ingredients, options } = input;
  const roundUp = options?.roundUp !== false;
  const sectionOrder = resolveSectionOrder(options?.sectionOrder);

  const recipesById = new Map<string, ListRecipe>();
  for (const recipe of input.recipes) recipesById.set(recipe.id, recipe);

  const pantryStatus = new Map<string, PantryEntry["status"]>();
  for (const row of input.pantry) pantryStatus.set(row.ingredient_id, row.status);

  const skippedEntries: GroceryListDraft["skippedEntries"] = [];
  const parsedGroups = new Map<
    string,
    { ingredient: Ingredient; qualifiers: string[]; sources: Source[] }
  >();
  const unparsedGroups = new Map<string, Source[]>();

  for (const entry of sortEntries(input.entries)) {
    if (entry.status === "skipped") continue;
    const recipe = recipesById.get(entry.recipe_id);
    if (!recipe || recipe.deleted_at) {
      const reason: SkippedReason = recipe ? "recipe_deleted" : "recipe_missing";
      skippedEntries.push({ entryId: entry.id, reason });
      continue;
    }
    const factorKnown = recipe.servings !== null && recipe.servings > 0;
    const factor = factorKnown ? entry.servings / (recipe.servings as number) : 1;
    const lines = [...recipe.ingredients].sort((a, b) => a.position - b.position);
    for (const line of lines) {
      const source = makeSource(entry, recipe, line, factor, factorKnown);
      const ingredient = line.ingredient_id ? ingredients.get(line.ingredient_id) : undefined;
      if (!ingredient) {
        const existing = unparsedGroups.get(line.id);
        if (existing) existing.push(source);
        else unparsedGroups.set(line.id, [source]);
        continue;
      }
      const qualifiers = extractQualifiers({
        prepNote: line.prep_note,
        rawText: line.raw_text,
        ingredientName: ingredient.name,
      });
      const key = `${ingredient.id}|${qualifiers.join(",")}`;
      const group = parsedGroups.get(key);
      if (group) group.sources.push(source);
      else parsedGroups.set(key, { ingredient, qualifiers, sources: [source] });
    }
  }

  const items: Array<PartialItem & { excludedReason?: "pantry" }> = [];
  for (const group of parsedGroups.values()) {
    const { ingredient, qualifiers } = group;
    // The pantry knows the ingredient, not the variety: a household that has soy sauce may not have
    // the gluten-free kind. A qualified item is therefore never covered by the pantry or by the
    // staple default, so a celiac household is not told it already has wheat flour's safe twin.
    const status = pantryStatus.get(ingredient.id) ?? (ingredient.isStapleDefault ? "have" : null);
    const covered = status === "have" && qualifiers.length === 0;
    for (const item of aggregateGroup(ingredient, qualifiers, group.sources, roundUp)) {
      items.push(covered ? { ...item, excludedReason: "pantry" } : item);
    }
  }
  for (const sources of unparsedGroups.values()) items.push(unparsedItem(sources));

  items.sort(
    (a, b) =>
      compareSections(sectionOrder, a.section, b.section) ||
      compareText(a.displayName, b.displayName) ||
      compareText(a.unit ?? "", b.unit ?? ""),
  );
  const positioned: DraftItem[] = items.map((item, position) => ({ ...item, position }));

  return {
    items: positioned,
    sectionOrder,
    needsAttentionCount: positioned.filter((item) => item.needsAttention && !item.excludedReason)
      .length,
    skippedEntries,
  };
}
