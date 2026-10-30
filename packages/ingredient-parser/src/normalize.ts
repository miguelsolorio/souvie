// Text normalization shared by the grammar, the lookup, and the cache key (WS03).
// No I/O and no Node APIs: this file also runs in Deno (Supabase Edge Functions).

const UNICODE_FRACTIONS: Readonly<Record<string, string>> = {
  "¼": "1/4",
  "½": "1/2",
  "¾": "3/4",
  "⅐": "1/7",
  "⅑": "1/9",
  "⅒": "1/10",
  "⅓": "1/3",
  "⅔": "2/3",
  "⅕": "1/5",
  "⅖": "2/5",
  "⅗": "3/5",
  "⅘": "4/5",
  "⅙": "1/6",
  "⅚": "5/6",
  "⅛": "1/8",
  "⅜": "3/8",
  "⅝": "5/8",
  "⅞": "7/8",
};

const FRACTION_CHARS = Object.keys(UNICODE_FRACTIONS).join("");
const FRACTION_RE = new RegExp(`(\\d)?\\s*([${FRACTION_CHARS}])`, "g");

/**
 * Tidy a raw ingredient line for parsing: ASCII fractions, plain dashes and quotes, single
 * spaces. Keeps case, because "T" (tablespoon) and "t" (teaspoon) differ.
 */
export function normalizeLine(raw: string): string {
  // Vulgar fractions first: NFKC would turn "1½" into "11⁄2".
  let s = raw.replace(FRACTION_RE, (_m, whole: string | undefined, frac: string) => {
    const f = UNICODE_FRACTIONS[frac] ?? frac;
    return whole ? `${whole} ${f}` : ` ${f}`;
  });
  s = s.normalize("NFKC").replace(/\u2044/g, "/");
  s = s
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u00A0\u2000-\u200B\u202F\u205F\uFEFF]/g, " ")
    .replace(/^[\s•·*▪◦☐□✓-]+(?=\S)/, "")
    .replace(/\s+/g, " ")
    .trim();
  return s;
}

/**
 * Cache key for a raw line: normalized, lowercase, no trailing punctuation.
 * Two spellings of the same line ("½ cup" and "1/2 cup") share a key.
 *
 * Lone "T" and "t" keep their case. The grammar reads them as tablespoon and teaspoon, so
 * "1 T salt" and "1 t salt" are different lines and must not share a cached result.
 */
export function cacheKey(raw: string): string {
  return normalizeLine(raw)
    .replace(/[.;:!]+$/, "")
    .trim()
    .split(" ")
    .map((token) => (/^[Tt]\.?$/.test(token) ? token.slice(0, 1) : token.toLowerCase()))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** Lowercase, straight quotes, hyphens kept, other punctuation to spaces. */
export function cleanPhrase(s: string): string {
  return s
    .toLowerCase()
    .replace(/[“”"]/g, "")
    .replace(/[’']s\b/g, "'s")
    .replace(/[*!?:;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[-.\s]+|[-.\s]+$/g, "");
}

const SINGULAR_EXCEPTIONS: Readonly<Record<string, string>> = {
  leaves: "leaf",
  loaves: "loaf",
  halves: "half",
  knives: "knife",
  cloves: "clove",
  olives: "olive",
  chives: "chive",
  berries: "berry",
  cherries: "cherry",
  tomatoes: "tomato",
  potatoes: "potato",
  mangoes: "mango",
  avocados: "avocado",
  radishes: "radish",
  peaches: "peach",
  anchovies: "anchovy",
  molasses: "molasses",
  hummus: "hummus",
  asparagus: "asparagus",
  couscous: "couscous",
  swiss: "swiss",
  citrus: "citrus",
  grits: "grits",
  oats: "oats",
  greens: "greens",
  bass: "bass",
  watercress: "watercress",
  lemongrass: "lemongrass",
  brussels: "brussels",
  chickpeas: "chickpea",
  lentils: "lentil",
};

/** Best-guess singular of one lowercase word. Returns the word itself when it looks singular. */
export function singularizeWord(word: string): string {
  // Own keys only: "constructor" and "toString" are words too, and must not hit Object.prototype.
  const exception = Object.hasOwn(SINGULAR_EXCEPTIONS, word)
    ? SINGULAR_EXCEPTIONS[word]
    : undefined;
  if (exception) return exception;
  if (word.length <= 3) return word;
  if (/(ss|us|is)$/.test(word)) return word;
  if (/ies$/.test(word)) return `${word.slice(0, -3)}y`;
  if (/(ch|sh|x|z|ss)es$/.test(word)) return word.slice(0, -2);
  if (/oes$/.test(word)) return word.slice(0, -2);
  if (/ves$/.test(word)) return `${word.slice(0, -3)}f`;
  if (/s$/.test(word)) return word.slice(0, -1);
  return word;
}

/** Singularize the last word of a phrase ("yellow onions" becomes "yellow onion"). */
export function singularizePhrase(phrase: string): string {
  const parts = phrase.split(" ");
  const last = parts.pop();
  if (last === undefined) return phrase;
  parts.push(singularizeWord(last));
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Trigram similarity, matching PostgreSQL pg_trgm
// ---------------------------------------------------------------------------

/**
 * The set of trigrams pg_trgm builds for a string: lowercase, split into words on anything
 * that is not a letter or digit, each word padded with two spaces in front and one behind.
 */
export function trigramSet(text: string): Set<string> {
  const out = new Set<string>();
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const word of words) {
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  }
  return out;
}

/** pg_trgm `similarity(a, b)`: shared trigrams over all distinct trigrams. */
export function trigramSimilarity(a: string, b: string): number {
  return setSimilarity(trigramSet(a), trigramSet(b));
}

export function setSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (large.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}
