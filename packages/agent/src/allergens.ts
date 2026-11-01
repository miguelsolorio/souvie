// The deterministic allergen check (docs/03-ai-design.md §11, docs/05 §Allergen safety, risk R4).
//
// The model never gets the last word on what is safe. This module decides, from the product's own
// allergen data and the household's block list, and nothing else:
//
//   * a product whose `allergens` CONTAIN a household allergen is blocked: it is never offered to
//     the model, never chosen, never shown, and never sent to a cart. The final check on the
//     proposed cart runs again whatever the model said, and the push phase runs it a third time on
//     freshly fetched products before any cart write.
//   * "may contain" and "not declared" (Product.mayContain, Product.undeclared, both subsets of
//     `allergens`) flag the line for review instead of blocking it (orchestrator correction 9).
//   * an allergen label we cannot map is flagged, never ignored.
//   * a product with no allergen data is flagged "allergen data unavailable" when its name or the
//     line's ontology category points at a household allergen (docs/05, R4). Produce with no data
//     is not flagged: most of it has none.
//
// Names are matched only to raise a flag, never to clear one.
import { ALLERGENS, type Allergen } from "@mp/core";
import type { Product } from "@mp/retailers";
import type { ItemFlag, ProposedItem } from "./types.ts";

/** How we say each allergen to a person. */
export const ALLERGEN_LABELS: Readonly<Record<Allergen, string>> = {
  peanut: "peanuts",
  tree_nut: "tree nuts",
  milk: "milk",
  egg: "eggs",
  wheat: "wheat",
  soy: "soy",
  fish: "fish",
  shellfish: "shellfish",
  sesame: "sesame",
};

/**
 * Retailer allergen labels, normalized (lowercase, letters and spaces), to our vocabulary.
 * Kroger names them "Milk", "Tree Nuts", "Crustacean Shellfish", and so on. Gluten maps to wheat
 * and coconut to tree nuts on purpose: when in doubt, the stricter reading.
 */
const LABEL_TO_ALLERGEN: Readonly<Record<string, Allergen>> = {
  peanut: "peanut",
  peanuts: "peanut",
  "tree nut": "tree_nut",
  "tree nuts": "tree_nut",
  nuts: "tree_nut",
  almond: "tree_nut",
  almonds: "tree_nut",
  cashew: "tree_nut",
  cashews: "tree_nut",
  walnut: "tree_nut",
  walnuts: "tree_nut",
  pecan: "tree_nut",
  pecans: "tree_nut",
  hazelnut: "tree_nut",
  hazelnuts: "tree_nut",
  pistachio: "tree_nut",
  pistachios: "tree_nut",
  coconut: "tree_nut",
  milk: "milk",
  dairy: "milk",
  "milk and dairy": "milk",
  lactose: "milk",
  egg: "egg",
  eggs: "egg",
  wheat: "wheat",
  gluten: "wheat",
  "wheat gluten": "wheat",
  soy: "soy",
  soya: "soy",
  soybean: "soy",
  soybeans: "soy",
  "soy lecithin": "soy",
  fish: "fish",
  shellfish: "shellfish",
  "crustacean shellfish": "shellfish",
  crustacean: "shellfish",
  crustaceans: "shellfish",
  mollusk: "shellfish",
  mollusks: "shellfish",
  molluscs: "shellfish",
  sesame: "sesame",
  "sesame seed": "sesame",
  "sesame seeds": "sesame",
};

export function normalizeAllergenLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/and (its|their) derivatives/g, "")
    .replace(/[^a-z]+/g, " ")
    .trim();
}

/** Our allergen for a retailer label, or null when we have no rule for it. */
export function allergenOfLabel(label: string): Allergen | null {
  return LABEL_TO_ALLERGEN[normalizeAllergenLabel(label)] ?? null;
}

/** Name terms that point at an allergen, with the phrases that do not ("almond milk" for milk). */
const NAME_TERMS: Readonly<Record<Allergen, { terms: RegExp; except?: RegExp }>> = {
  peanut: { terms: /\b(peanuts?|groundnuts?)\b/ },
  tree_nut: {
    terms:
      /\b(almonds?|cashews?|walnuts?|pecans?|pistachios?|hazelnuts?|macadamias?|brazil nuts?|pine nuts?|pralines?|marzipan|coconut|nutella|tree nuts?)\b/,
  },
  milk: {
    terms:
      /\b(milk|cheese|cheddar|mozzarella|parmesan|ricotta|butter|buttermilk|cream|creamer|yogh?urt|whey|casein|ghee|kefir|curds?)\b/,
    except:
      /\b(almond|oat|soy|coconut|rice|cashew|hemp|plant) milk\b|\b(peanut|almond|nut|apple|cocoa|shea|sunflower|seed) butter\b|\bcream of tartar\b|\bnon dairy\b|\bdairy free\b/,
  },
  egg: { terms: /\b(eggs?|mayonnaise|mayo|meringue)\b/ },
  wheat: {
    terms:
      /\b(wheat|flour|bread|breadcrumbs?|panko|pasta|spaghetti|penne|rigate|macaroni|fettuccine|linguine|lasagna|noodles?|couscous|semolina|tortillas?|crackers?|pie crust|pastry|pizza|waffles?|pancakes?|biscuits?|seitan|soy sauce|croutons?)\b/,
    except:
      /\b(rice|almond|coconut|corn|oat|chickpea|tapioca|potato|cassava|cauliflower) (flour|noodles?|tortillas?|pasta|crust)\b|\bgluten free\b/,
  },
  soy: { terms: /\b(soy|soya|soybeans?|tofu|edamame|tempeh|miso|tamari)\b/ },
  fish: {
    terms:
      /\b(fish|salmon|tuna|cod|tilapia|halibut|trout|anchov(y|ies)|sardines?|mackerel|pollock|catfish|bass|snapper|mahi)\b/,
    except: /\bshellfish\b/,
  },
  shellfish: {
    terms:
      /\b(shellfish|shrimp|prawns?|crabs?|lobsters?|crawfish|crayfish|scallops?|clams?|mussels?|oysters?)\b/,
  },
  sesame: { terms: /\b(sesame|tahini|hummus)\b/ },
};

/** Ontology categories that are a clean signal for an allergen (mirrors the suggest filters). */
const CATEGORY_ALLERGENS: Readonly<Record<string, readonly Allergen[]>> = {
  dairy: ["milk"],
  eggs: ["egg"],
  seafood: ["fish", "shellfish"],
  bakery: ["wheat"],
};

function nameText(name: string): string {
  return name.toLowerCase().replace(/[^a-z]+/g, " ");
}

/** The allergens a product name points at. A raised flag only: never used to clear one. */
export function allergensInName(name: string): Allergen[] {
  const text = ` ${nameText(name)} `;
  return ALLERGENS.filter((allergen) => {
    const rule = NAME_TERMS[allergen];
    if (!rule.terms.test(text)) return false;
    if (!rule.except) return true;
    // A name that hits only through an excepted phrase ("almond milk") does not count.
    const stripped = text.replace(new RegExp(rule.except.source, "g"), " ");
    return rule.terms.test(stripped);
  });
}

export interface AllergenVerdict {
  /** Household allergens the product contains. Non-empty means the product is blocked. */
  blocked: Allergen[];
  /** Flags that send the line to review. Empty when nothing is in doubt. */
  flags: ItemFlag[];
}

export interface AllergenCheckContext {
  /** The ontology category of the line's ingredient, when known. */
  ingredientCategory?: string | null | undefined;
}

function sameLabel(a: string, b: string): boolean {
  return normalizeAllergenLabel(a) === normalizeAllergenLabel(b);
}

function list(allergens: readonly Allergen[]): string {
  return allergens.map((a) => ALLERGEN_LABELS[a]).join(", ");
}

/**
 * The verdict for one product against the household's block list. Pure and deterministic: same
 * product, same list, same answer. With an empty block list nothing is blocked or flagged.
 */
export function checkProduct(
  product: Pick<Product, "name" | "allergens" | "mayContain" | "undeclared">,
  blockList: readonly Allergen[],
  context: AllergenCheckContext = {},
): AllergenVerdict {
  const blocks = new Set(blockList);
  if (blocks.size === 0) return { blocked: [], flags: [] };

  const blocked = new Set<Allergen>();
  const doubtful = new Set<Allergen>();
  const unknownLabels: string[] = [];
  const softLabels = [...product.mayContain, ...product.undeclared];

  for (const label of product.allergens) {
    const allergen = allergenOfLabel(label);
    if (allergen === null) {
      unknownLabels.push(label);
      continue;
    }
    if (!blocks.has(allergen)) continue;
    if (softLabels.some((soft) => sameLabel(soft, label))) doubtful.add(allergen);
    else blocked.add(allergen);
  }
  // A "may contain" label missing from `allergens` would be a retailer data bug; read it anyway.
  for (const label of softLabels) {
    const allergen = allergenOfLabel(label);
    if (allergen && blocks.has(allergen) && !blocked.has(allergen)) doubtful.add(allergen);
  }

  const flags: ItemFlag[] = [];
  if (blocked.size > 0) {
    flags.push({
      kind: "allergen",
      detail: `A product listing ${list([...blocked])} was left out (household allergy).`,
    });
  }
  const mayContain = [...doubtful].filter((a) => !blocked.has(a));
  if (mayContain.length > 0) {
    flags.push({
      kind: "allergen_may_contain",
      detail: `The product may contain or does not declare ${list(mayContain)}. Check the label.`,
    });
  }
  if (unknownLabels.length > 0) {
    flags.push({
      kind: "allergen_unknown",
      detail: "The product lists an allergen we cannot read. Check the label.",
    });
  }

  // No data, or data that misses what the name or the ingredient says.
  const listed = new Set(
    product.allergens.map(allergenOfLabel).filter((a): a is Allergen => a !== null),
  );
  // The category rule skips a product whose name is an excepted phrase: oat milk is filed under
  // dairy in the ontology, but its name says it is not milk.
  const text = ` ${nameText(product.name)} `;
  const fromCategory = (
    Object.hasOwn(CATEGORY_ALLERGENS, context.ingredientCategory ?? "")
      ? (CATEGORY_ALLERGENS[context.ingredientCategory ?? ""] ?? [])
      : []
  ).filter((allergen) => {
    const except = NAME_TERMS[allergen].except;
    return !except?.test(text);
  });
  const pointedAt = new Set<Allergen>([...allergensInName(product.name), ...fromCategory]);
  const missing = [...pointedAt].filter((a) => blocks.has(a) && !listed.has(a));
  if (missing.length > 0 && blocked.size === 0) {
    flags.push({
      kind: "allergen_data_missing",
      detail: `Allergen data unavailable, and this may contain ${list(missing)}. Check the label.`,
    });
  }

  return { blocked: [...blocked], flags };
}

/** True when the product may go in the cart at all (it may still need review). */
export function isAllowed(verdict: AllergenVerdict): boolean {
  return verdict.blocked.length === 0;
}

export interface EnforcedCart {
  items: ProposedItem[];
  /** Lines whose chosen product was dropped here. */
  removed: number;
}

/**
 * The last check before review, on the whole proposed cart, whatever chose each product: code,
 * the model, or a replayed recording. A chosen product that lists a household allergen is dropped
 * from its line (status removed, no product shown) and the line is flagged; an alternative that
 * lists one is dropped from the alternatives. A product the check cannot see (not in `products`)
 * is treated the same way, since it cannot be verified.
 */
export function enforceAllergens(
  items: readonly ProposedItem[],
  products: ReadonlyMap<string, Product>,
  blockList: readonly Allergen[],
  categories: ReadonlyMap<string, string | null> = new Map(),
): EnforcedCart {
  if (blockList.length === 0) return { items: [...items], removed: 0 };
  let removed = 0;
  const out = items.map((item): ProposedItem => {
    const category = categories.get(item.listItemId) ?? null;
    const safe = (productId: string) => {
      const product = products.get(productId);
      if (!product) return false;
      return (
        checkProduct(product, blockList, { ingredientCategory: category }).blocked.length === 0
      );
    };
    const alternatives = item.alternatives.filter((alt) => safe(alt.product_id));
    if (!item.product) return { ...item, alternatives };
    const product = products.get(item.product.productId);
    const verdict = product
      ? checkProduct(product, blockList, { ingredientCategory: category })
      : { blocked: [...blockList], flags: [] };
    if (verdict.blocked.length === 0) return { ...item, alternatives };

    removed += 1;
    const detail = product
      ? `The proposed product lists ${list(verdict.blocked)}, a household allergy, so it was removed.`
      : "The proposed product could not be checked for allergens, so it was removed.";
    return {
      ...item,
      product: null,
      qty: null,
      unitPriceUsd: null,
      lineTotalUsd: null,
      status: "removed",
      alternatives,
      flags: [...item.flags.filter((f) => f.kind !== "allergen"), { kind: "allergen", detail }],
      reason: "Removed by the allergen check.",
    };
  });
  return { items: out, removed };
}
