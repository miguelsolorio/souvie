import { describe, expect, it } from "vitest";
import {
  cacheKey,
  cleanPhrase,
  normalizeLine,
  setSimilarity,
  singularizePhrase,
  singularizeWord,
  trigramSet,
  trigramSimilarity,
} from "./normalize";

describe("normalizeLine", () => {
  it("turns unicode fractions into ASCII", () => {
    expect(normalizeLine("½ cup sugar")).toBe("1/2 cup sugar");
    expect(normalizeLine("¾ cup milk")).toBe("3/4 cup milk");
    expect(normalizeLine("⅔ cup brown sugar")).toBe("2/3 cup brown sugar");
  });

  it("keeps mixed numbers readable, glued or spaced", () => {
    expect(normalizeLine("1½ cups flour")).toBe("1 1/2 cups flour");
    expect(normalizeLine("1 ½ cups flour")).toBe("1 1/2 cups flour");
    expect(normalizeLine("2¼ teaspoons yeast")).toBe("2 1/4 teaspoons yeast");
  });

  it("normalizes dashes, quotes, spaces, and bullets", () => {
    expect(normalizeLine("2–3  cloves   garlic")).toBe("2-3 cloves garlic");
    expect(normalizeLine("• 1 cup flour")).toBe("1 cup flour");
    expect(normalizeLine("  1 cup\tmilk ")).toBe("1 cup milk");
  });

  it("preserves case, which separates T from t", () => {
    expect(normalizeLine("1 T flour")).toBe("1 T flour");
    expect(normalizeLine("1 t salt")).toBe("1 t salt");
  });
});

describe("cacheKey", () => {
  it("gives equivalent spellings one key", () => {
    expect(cacheKey("½ cup  Sugar.")).toBe(cacheKey("1/2 cup sugar"));
    expect(cacheKey("1 CUP Milk")).toBe("1 cup milk");
  });
});

describe("cleanPhrase and singularize", () => {
  it("lowercases and tidies", () => {
    expect(cleanPhrase('  Fresh "Basil"  ')).toBe("fresh basil");
  });

  it("singularizes common plurals", () => {
    expect(singularizeWord("tomatoes")).toBe("tomato");
    expect(singularizeWord("berries")).toBe("berry");
    expect(singularizeWord("leaves")).toBe("leaf");
    expect(singularizeWord("onions")).toBe("onion");
    expect(singularizeWord("peaches")).toBe("peach");
    expect(singularizeWord("molasses")).toBe("molasses");
    expect(singularizeWord("asparagus")).toBe("asparagus");
    expect(singularizeWord("hummus")).toBe("hummus");
    expect(singularizeWord("oats")).toBe("oats");
    expect(singularizePhrase("yellow onions")).toBe("yellow onion");
  });
});

describe("trigram similarity matches pg_trgm", () => {
  it("builds padded trigrams per word", () => {
    expect([...trigramSet("cat")].sort()).toEqual(["  c", " ca", "at ", "cat"]);
    expect(trigramSet("a b").size).toBe(4);
  });

  // Reference values are `select similarity(a, b)` from PostgreSQL 17.5 with pg_trgm
  // (run through PGlite while building WS03).
  it.each([
    ["word", "two words", 0.36363637],
    ["tomato", "tomatoes", 0.6],
    ["onion", "onions", 0.625],
    ["yellow onion", "yellow onions", 0.8],
    ["cilantro", "coriander", 0.055555556],
  ])("similarity(%s, %s) is %f", (a, b, expected) => {
    expect(trigramSimilarity(a, b)).toBeCloseTo(expected, 5);
  });

  it("is 1 for equal strings and 0 for empty ones", () => {
    expect(trigramSimilarity("basil", "basil")).toBe(1);
    expect(trigramSimilarity("", "basil")).toBe(0);
    expect(setSimilarity(new Set(), new Set(["abc"]))).toBe(0);
  });
});
