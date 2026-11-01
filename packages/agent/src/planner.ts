// Line-item conversion (docs/03-ai-design.md §7): from a list line and the products a retailer
// returned for it, to one proposed shopping_run_items row with up to three alternatives.
//
// The scorer is deterministic and pure. Candidates are first narrowed, then ranked:
//
//   narrowed out   products that do not name the line's food as well as the best ones do;
//                  products that list a household allergen (allergens.ts); products that lack
//                  the line's qualifier ("gluten-free"); products the substitution policy refuses;
//                  out-of-stock products, while anything else is in stock.
//   ranked by      pinned > household's past pick > unit-price fit > profile preference > stock,
//                  compared in that order (a lexicographic score), so a lower factor only breaks
//                  a tie in every factor above it. Unit-price fit is banded to tenths, so two
//                  products within ten percent of each other's cost tie on it.
//
// The model sees only the ranked, narrowed list, numbered, and answers with an index. Code maps
// the index back to the Product the adapter returned (see tools.ts, choose_product); the model
// never writes an id or a UPC (R13).

import type { RunPolicy } from "@mp/core";
import { extractQualifiers } from "@mp/core";
import type { Product, StockLevel } from "@mp/retailers";
import { type AllergenVerdict, checkProduct } from "./allergens.ts";
import {
  cents,
  checkSubstitution,
  itemCeilingFlag,
  type SubstitutionReference,
} from "./policies.ts";
import { type BuyPlan, matchesContainerHint, unitsToBuy } from "./sizes.ts";
import type {
  Alternative,
  ChosenProduct,
  ItemFlag,
  ListLine,
  ProposedItem,
  RunItemStatus,
  ShoppingPreferences,
} from "./types.ts";

/** The order of the score tuple. */
export const SCORE_FACTORS = ["pinned", "pastPick", "unitPriceFit", "preference", "stock"] as const;
export type ScoreTuple = readonly [number, number, number, number, number];

/** Candidates the model sees per line. */
export const MODEL_CANDIDATES = 8;
/** Alternatives shown at review. */
export const MAX_ALTERNATIVES = 3;
/** Search results asked for per line (the brief's ceiling). */
export const SEARCH_LIMIT = 25;

export interface ScoredCandidate {
  product: Product;
  plan: BuyPlan;
  /** plan.units times the effective price, or null with no price. */
  lineTotal: number | null;
  score: ScoreTuple;
  /** Review flags that come with this product (may contain, no allergen data). */
  allergenFlags: ItemFlag[];
  /** Short tags for the model and the transcript: "pinned", "usual", "best value". */
  notes: string[];
}

export interface ExclusionCounts {
  irrelevant: number;
  allergen: number;
  qualifier: number;
  substitution: number;
  outOfStock: number;
}

export interface PreparedLine {
  line: ListLine;
  /** Ranked best first. Index into this is what the model answers with. */
  ranked: ScoredCandidate[];
  excluded: ExclusionCounts;
  /** No candidate carries every qualifier the line asks for. `ranked` then holds the nearest. */
  qualifierMissing: boolean;
  /** The best-ranked product before the allergen check was blocked. */
  topBlocked: boolean;
  /** Every candidate is out of stock. */
  allOutOfStock: boolean;
  reference: SubstitutionReference | null;
  /** Flags about the line as a whole, before any choice. */
  flags: ItemFlag[];
}

export interface ScoringContext {
  /** The household's pinned product for the line's ingredient at this store, if any. */
  pinnedProductId: string | null;
  /** Products the household chose before for this ingredient (product_matches, not pinned). */
  pastPickIds: ReadonlySet<string>;
  preferences: ShoppingPreferences;
}

export interface PrepareContext extends ScoringContext {
  policy: Pick<RunPolicy, "substitution">;
  reference: SubstitutionReference | null;
  allergies: Parameters<typeof checkProduct>[1];
}

// ---------------------------------------------------------------------------------------
// Words and relevance
// ---------------------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "of",
  "the",
  "with",
  "for",
  "fresh",
  "or",
  "to",
  "in",
]);

/** Lowercase word stems, the way the mock and most catalogs match: "Thighs" and "thigh" agree. */
export function stems(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9%]+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
    .map((word) => (word.length > 3 ? word.replace(/(es|s)$/, "") : word));
}

/** The words that name a line's food: the ontology name and the display name. */
export function lineWords(line: Pick<ListLine, "ingredient" | "displayName">): string[] {
  // The display name can be more specific than the ontology ("Boneless skinless chicken thighs"
  // for "chicken thigh"), so both count. Qualifiers in parentheses are matched separately.
  const display = line.displayName.replace(/\(.*?\)/g, " ");
  return [...new Set([...stems(line.ingredient?.name ?? ""), ...stems(display)])];
}

/** Count and size words that end a product name without naming the food. */
const TAIL_WORDS = new Set(["ct", "oz", "lb", "pk", "pack", "bag", "box", "can", "jar", "each"]);

/**
 * How well a product name names the line's food: two points per line word it carries, and one
 * more when its last word, the head noun, is one of them ("Garlic Bread" is bread, not garlic).
 */
export function relevance(
  line: Pick<ListLine, "ingredient" | "displayName">,
  product: Pick<Product, "name">,
): number {
  const wanted = new Set(lineWords(line));
  const have = stems(product.name).filter((word) => /[a-z]/.test(word) && !TAIL_WORDS.has(word));
  const matched = [...new Set(have)].filter((word) => wanted.has(word)).length;
  const head = have[have.length - 1];
  return matched * 2 + (head !== undefined && wanted.has(head) ? 1 : 0);
}

/** The search text for a line: qualifiers first, then the ontology name or the raw text. */
export function searchQuery(
  line: Pick<ListLine, "ingredient" | "displayName" | "qualifiers">,
): string {
  const base = line.ingredient?.name ?? line.displayName.replace(/\s+/g, " ").trim();
  const qualifiers = line.qualifiers.filter((q) => !base.toLowerCase().includes(q.toLowerCase()));
  return [...qualifiers, base].join(" ").slice(0, 120);
}

/** True when the product name carries every qualifier the line asks for. */
export function carriesQualifiers(
  line: Pick<ListLine, "qualifiers">,
  product: Pick<Product, "name">,
): boolean {
  if (line.qualifiers.length === 0) return true;
  const found = new Set(extractQualifiers({ rawText: product.name }));
  return line.qualifiers.every((q) => found.has(q));
}

// ---------------------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------------------

export function effectivePrice(product: Pick<Product, "price" | "promoPrice">): number | null {
  return product.promoPrice ?? product.price;
}

const STOCK_SCORE: Readonly<Record<StockLevel, number>> = {
  HIGH: 2,
  LOW: 1,
  UNKNOWN: 1,
  TEMPORARILY_OUT_OF_STOCK: 0,
};

/** -2 to 3, shifted to 0 to 5: brand liked or avoided, organic when the household prefers it. */
export function preferenceScore(
  product: Pick<Product, "brand" | "name">,
  preferences: ShoppingPreferences,
): number {
  const brand = product.brand?.trim().toLowerCase() ?? "";
  let score = 0;
  if (brand && preferences.preferredBrands.some((b) => b.trim().toLowerCase() === brand))
    score += 2;
  if (brand && preferences.avoidBrands.some((b) => b.trim().toLowerCase() === brand)) score -= 2;
  if (preferences.preferOrganic && /\borganic\b/i.test(product.name)) score += 1;
  return score + 2;
}

/** Descending: the better candidate sorts first. */
export function compareScores(a: ScoreTuple, b: ScoreTuple): number {
  for (let i = 0; i < a.length; i++) {
    const diff = (b[i] ?? 0) - (a[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** An unknown fit sits below every compared one that is reasonable, above the poorest. */
const UNKNOWN_FIT_BAND = 3;

/**
 * Scores and ranks products for a line. Unit-price fit is relative: the cheapest way to cover the
 * line among these products is 10, one that costs twice as much is 5. A product whose size
 * matches the recipes' container size gets one band more. Ties after every factor keep the
 * retailer's order, which is its own relevance ranking.
 */
export function scoreCandidates(
  line: ListLine,
  products: readonly Product[],
  ctx: ScoringContext,
): ScoredCandidate[] {
  const plans = products.map((product) => {
    const plan = unitsToBuy(line, product);
    const price = effectivePrice(product);
    const lineTotal = price === null ? null : cents(price * plan.units);
    return { product, plan, lineTotal };
  });
  const comparable = plans.filter((p) => p.plan.known && p.lineTotal !== null && p.lineTotal > 0);
  const cheapest =
    comparable.length > 0 ? Math.min(...comparable.map((p) => p.lineTotal ?? 0)) : null;

  const scored = plans.map(({ product, plan, lineTotal }, order) => {
    let fit: number;
    if (lineTotal === null) fit = 0;
    else if (!plan.known || cheapest === null || lineTotal <= 0) fit = UNKNOWN_FIT_BAND;
    else fit = Math.round((cheapest / lineTotal) * 10);
    if (lineTotal !== null && matchesContainerHint(line, product)) fit = Math.min(10, fit + 1);

    const pinned = ctx.pinnedProductId === product.id ? 1 : 0;
    const past = ctx.pastPickIds.has(product.id) ? 1 : 0;
    const score: ScoreTuple = [
      pinned,
      past,
      fit,
      preferenceScore(product, ctx.preferences),
      STOCK_SCORE[product.stockLevel],
    ];
    const notes: string[] = [];
    if (pinned) notes.push("pinned");
    if (past) notes.push("usual pick");
    if (cheapest !== null && lineTotal === cheapest && plan.known) notes.push("best value");
    if (score[3] > 2) notes.push("preferred");
    if (score[3] < 2) notes.push("avoided brand");
    if (product.stockLevel === "LOW") notes.push("low stock");
    if (product.stockLevel === "TEMPORARILY_OUT_OF_STOCK") notes.push("out of stock");
    return { candidate: { product, plan, lineTotal, score, allergenFlags: [], notes }, order };
  });

  scored.sort((a, b) => compareScores(a.candidate.score, b.candidate.score) || a.order - b.order);
  return scored.map((s) => s.candidate);
}

// ---------------------------------------------------------------------------------------
// Narrowing
// ---------------------------------------------------------------------------------------

/**
 * Narrows and ranks one line's candidates. Products arrive from the adapter (a search, or the
 * batch lookup for a pinned product); nothing here invents or edits one.
 */
export function prepareLine(
  line: ListLine,
  products: readonly Product[],
  ctx: PrepareContext,
): PreparedLine {
  const excluded: ExclusionCounts = {
    irrelevant: 0,
    allergen: 0,
    qualifier: 0,
    substitution: 0,
    outOfStock: 0,
  };
  const flags: ItemFlag[] = [];
  const unique = [...new Map(products.map((p) => [p.id, p])).values()];
  const known = (p: Product) => p.id === ctx.pinnedProductId || ctx.pastPickIds.has(p.id);

  // Relevance: keep the products that name the food as well as the best one does.
  const best = Math.max(0, ...unique.map((p) => relevance(line, p)));
  let pool = unique.filter((p) => known(p) || relevance(line, p) >= best);
  excluded.irrelevant = unique.length - pool.length;

  // Allergens, before anything is ranked or shown.
  const verdicts = new Map<string, AllergenVerdict>();
  for (const product of pool) {
    verdicts.set(
      product.id,
      checkProduct(product, ctx.allergies, { ingredientCategory: line.ingredient?.category }),
    );
  }
  const preRanked = scoreCandidates(line, pool, ctx);
  const topBlocked = (verdicts.get(preRanked[0]?.product.id ?? "")?.blocked.length ?? 0) > 0;
  const safe = pool.filter((p) => (verdicts.get(p.id)?.blocked.length ?? 0) === 0);
  excluded.allergen = pool.length - safe.length;
  pool = safe;
  if (topBlocked) {
    const verdict = verdicts.get(preRanked[0]?.product.id ?? "");
    flags.push(
      verdict?.flags.find((f) => f.kind === "allergen") ?? {
        kind: "allergen",
        detail: "A product listing a household allergen was left out.",
      },
    );
  }

  // Qualifiers: a qualified line takes only products that say so.
  let qualifierMissing = false;
  if (line.qualifiers.length > 0) {
    const qualified = pool.filter((p) => carriesQualifiers(line, p));
    excluded.qualifier = pool.length - qualified.length;
    if (qualified.length === 0 && pool.length > 0) {
      qualifierMissing = true;
      flags.push({
        kind: "qualifier",
        detail: `No product here says ${line.qualifiers.join(" and ")}. Pick one yourself or leave it out.`,
      });
    } else {
      pool = qualified;
    }
  }

  // Substitution policy, relative to the pinned product.
  if (ctx.reference) {
    const allowed = pool.filter((p) => checkSubstitution(ctx.policy, ctx.reference, p).allowed);
    excluded.substitution = pool.length - allowed.length;
    pool = allowed;
  }

  // Stock: out-of-stock products only when nothing else is left.
  const inStock = pool.filter((p) => p.stockLevel !== "TEMPORARILY_OUT_OF_STOCK");
  const allOutOfStock = pool.length > 0 && inStock.length === 0;
  if (!allOutOfStock) {
    excluded.outOfStock = pool.length - inStock.length;
    pool = inStock;
  } else {
    flags.push({ kind: "out_of_stock", detail: "Every match is out of stock at this store." });
  }

  const ranked = scoreCandidates(line, pool, ctx).map((candidate) => ({
    ...candidate,
    allergenFlags: (verdicts.get(candidate.product.id)?.flags ?? []).filter(
      (f) => f.kind !== "allergen",
    ),
  }));

  if (ctx.pinnedProductId && !ranked.some((c) => c.product.id === ctx.pinnedProductId)) {
    flags.push({
      kind: "pinned_unavailable",
      detail:
        "Your pinned product is not available or not safe here today, so another is proposed.",
    });
  }
  if (line.needsAttention || !line.ingredient) {
    flags.push({
      kind: "needs_attention",
      detail: "This list line was hard to read, so check the product matches what you meant.",
    });
  }

  return {
    line,
    ranked,
    excluded,
    qualifierMissing,
    topBlocked,
    allOutOfStock,
    reference: ctx.reference,
    flags,
  };
}

/**
 * Whether code may choose by itself. The model is asked when the line is free text or unclear,
 * or when the two best candidates tie on pinned and past pick and are within one fit band. A
 * pinned or usual product is code's call.
 */
export function needsModel(prepared: PreparedLine): boolean {
  if (prepared.ranked.length === 0 || prepared.qualifierMissing) return false;
  if (prepared.line.needsAttention || !prepared.line.ingredient) return true;
  const [first, second] = prepared.ranked;
  if (!first || !second) return false;
  if (first.score[0] === 1 || first.score[1] === 1) return false;
  return first.score[2] - second.score[2] <= 1;
}

// ---------------------------------------------------------------------------------------
// The proposed row
// ---------------------------------------------------------------------------------------

export type LineDecision =
  | {
      kind: "chosen";
      /** Index into PreparedLine.ranked. */
      index: number;
      units: number;
      by: "host" | "model";
      reason: string | null;
      /** The pick needs a second look (the model was unsure, or code picked without the model). */
      lowConfidence?: ItemFlag | null;
    }
  | { kind: "unmatched"; by: "host" | "model"; reason: string; flag?: ItemFlag | null };

export function chosenProduct(product: Product): ChosenProduct {
  return {
    productId: product.id,
    upc: product.upc,
    name: product.name,
    brand: product.brand,
    size: product.size,
    price: effectivePrice(product),
  };
}

export function alternativeOf(candidate: ScoredCandidate): Alternative {
  return {
    product_id: candidate.product.id,
    upc: candidate.product.upc,
    name: candidate.product.name,
    size: candidate.product.size,
    price: effectivePrice(candidate.product),
    qty: candidate.plan.units,
  };
}

/** Builds the shopping_run_items row for a line from its candidates and the decision. */
export function proposeItem(
  id: string,
  prepared: PreparedLine,
  decision: LineDecision,
  policy: Pick<RunPolicy, "per_item_ceiling_usd" | "substitution">,
): ProposedItem {
  const { line } = prepared;
  const base = {
    id,
    listItemId: line.id,
    position: line.position,
    displayName: line.displayName,
    section: line.section,
    ingredientId: line.ingredient?.id ?? null,
  };
  const flags: ItemFlag[] = [...prepared.flags];

  const chosen = decision.kind === "chosen" ? prepared.ranked[decision.index] : undefined;
  if (!chosen) {
    const reason = decision.kind === "unmatched" ? decision.reason : "No usable product was found.";
    if (decision.kind === "unmatched" && decision.flag) flags.push(decision.flag);
    if (!flags.some((f) => f.kind === "qualifier" || f.kind === "unmatched")) {
      flags.push({ kind: "unmatched", detail: "No product was chosen for this line." });
    }
    return {
      ...base,
      product: null,
      qty: null,
      unitPriceUsd: null,
      lineTotalUsd: null,
      status: "unmatched",
      alternatives: prepared.ranked.slice(0, MAX_ALTERNATIVES).map(alternativeOf),
      flags: dedupeFlags(flags),
      reason: reason.slice(0, 500),
    };
  }

  const units = decision.kind === "chosen" ? decision.units : chosen.plan.units;
  const price = effectivePrice(chosen.product);
  const lineTotal = price === null ? null : cents(price * units);
  const substitution = checkSubstitution(policy, prepared.reference, chosen.product);
  const status: RunItemStatus = substitution.substitution ? "substituted" : "matched";
  if (substitution.substitution && substitution.crossesBrand) {
    flags.push({
      kind: "substitution",
      detail: "This is a different brand from your pinned product.",
    });
  }
  flags.push(...chosen.allergenFlags);
  const ceiling = itemCeilingFlag(policy, lineTotal);
  if (ceiling) flags.push(ceiling);
  if (decision.kind === "chosen" && decision.lowConfidence) flags.push(decision.lowConfidence);

  return {
    ...base,
    product: chosenProduct(chosen.product),
    qty: units,
    unitPriceUsd: price,
    lineTotalUsd: lineTotal,
    status,
    alternatives: prepared.ranked
      .filter((c) => c.product.id !== chosen.product.id)
      .slice(0, MAX_ALTERNATIVES)
      .map(alternativeOf),
    flags: dedupeFlags(flags),
    reason: decision.reason ? decision.reason.slice(0, 500) : null,
  };
}

function dedupeFlags(flags: readonly ItemFlag[]): ItemFlag[] {
  const seen = new Set<string>();
  return flags.filter((flag) => {
    const key = `${flag.kind}:${flag.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Sum of the lines that will go in the cart. */
export function subtotalOf(items: readonly ProposedItem[]): number {
  return cents(
    items
      .filter((item) => item.status === "matched" || item.status === "substituted")
      .reduce((sum, item) => sum + (item.lineTotalUsd ?? 0), 0),
  );
}

/** Lines that carry a flag: what "N items need your call" counts. */
export function reviewCount(items: readonly ProposedItem[]): number {
  return items.filter((item) => item.flags.length > 0).length;
}
