// Qualifiers on an ingredient line (WS05). "gluten-free pasta" and "pasta" share an ingredient id
// but are different things to buy: a celiac household's cart must not get wheat pasta because a
// plain line asked for pasta too (WS16 review, 2026-10-30). So the list never merges a qualified
// line into an unqualified one, carries the qualifier on the item, and names it in the item's
// display name so the retailer search sees it.
//
// Today the qualifier arrives in the line's `prep_note` or in its raw text; WS03 may give it a
// structured field later. The vocabulary is closed on purpose. A phrase outside it is
// preparation ("diced", "packed"), not a different product.

interface QualifierRule {
  /** The canonical name stored on the item. */
  name: string;
  pattern: RegExp;
}

// Hyphens in these patterns match a hyphen, a space, or nothing: "gluten free", "gluten-free",
// "glutenfree". A word boundary in front and a guard behind keep "sugar-free" out of
// "sugar free-range" and "gf" out of "gfruit".
function qualifier(name: string, body: string): QualifierRule {
  return { name, pattern: new RegExp(`\\b(?:${body})(?![a-z]|-[a-z])`) };
}

const RULES: readonly QualifierRule[] = [
  qualifier("gluten-free", "gluten[\\s-]?free|gf"),
  qualifier("dairy-free", "(?:dairy|milk)[\\s-]?free"),
  qualifier("lactose-free", "lactose[\\s-]?free"),
  qualifier("nut-free", "(?:tree[\\s-]?)?nut[\\s-]?free"),
  qualifier("peanut-free", "peanut[\\s-]?free"),
  qualifier("soy-free", "soy[\\s-]?free"),
  qualifier("egg-free", "egg[\\s-]?free"),
  qualifier("grain-free", "grain[\\s-]?free"),
  qualifier("sugar-free", "sugar[\\s-]?free|no[\\s-]sugar[\\s-]added"),
  qualifier("vegan", "vegan"),
  qualifier("unsalted", "unsalted"),
  qualifier("unsweetened", "unsweetened"),
  qualifier("low-sodium", "(?:low|reduced|less)[\\s-]sodium"),
  qualifier("no-salt-added", "no[\\s-]salt[\\s-]added|salt[\\s-]free"),
  qualifier("fat-free", "fat[\\s-]?free|non[\\s-]?fat"),
  qualifier("low-fat", "(?:low|reduced)[\\s-]fat"),
  qualifier("decaf", "decaf(?:feinated)?"),
];

/** Every qualifier the list tells apart. */
export const QUALIFIER_NAMES: readonly string[] = RULES.map((entry) => entry.name);

/** Dashes of every kind to a plain hyphen, lowercase, collapsed whitespace. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ");
}

/**
 * The qualifiers a line carries, sorted, each once. Looks in the line's preparation note and its
 * raw text. A qualifier the ingredient's own name already says ("unsalted butter") is dropped,
 * so it is not written twice.
 */
export function extractQualifiers(args: {
  prepNote?: string | null | undefined;
  rawText?: string | null | undefined;
  ingredientName?: string | null | undefined;
}): string[] {
  const haystack = normalize(`${args.prepNote ?? ""} | ${args.rawText ?? ""}`);
  const own = normalize(args.ingredientName ?? "");
  const found = new Set<string>();
  for (const entry of RULES) {
    if (!entry.pattern.test(haystack)) continue;
    if (own && entry.pattern.test(own)) continue;
    found.add(entry.name);
  }
  return [...found].sort();
}

/** "Pasta (gluten-free)". With no qualifiers, the name unchanged. */
export function withQualifiers(name: string, qualifiers: readonly string[]): string {
  return qualifiers.length === 0 ? name : `${name} (${qualifiers.join(", ")})`;
}
