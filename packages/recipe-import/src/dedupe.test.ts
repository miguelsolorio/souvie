import { describe, expect, it } from "vitest";
import { LINK_CASES } from "./dedupe.fixtures.ts";
import {
  dedupeIngredientLines,
  normalizeSourceUrl,
  normalizeTitle,
  TRACKING_PARAM,
  titleSearchPattern,
} from "./dedupe.ts";
import { cleanSourceUrl } from "./normalize.ts";

describe("normalizeSourceUrl", () => {
  it.each(LINK_CASES)("%j -> %j", (input, expected) => {
    expect(normalizeSourceUrl(input)).toBe(expected);
  });

  it("makes the spellings of one page equal", () => {
    const spellings = [
      "https://Example.com/recipes/lemon-chicken",
      "https://example.com/recipes/lemon-chicken/",
      "https://example.com/recipes/lemon-chicken?utm_source=newsletter&utm_medium=email",
      "https://example.com/recipes/lemon-chicken#comments",
      "https://example.com/recipes/lemon-chicken/?fbclid=abc#top",
      "HTTPS://EXAMPLE.COM/recipes/lemon-chicken?gclid=1",
    ];
    expect(new Set(spellings.map(normalizeSourceUrl)).size).toBe(1);
  });

  it("keeps different pages apart", () => {
    const pages = [
      "https://example.com/recipes/lemon-chicken",
      "https://example.com/recipes/Lemon-Chicken",
      "https://example.com/recipes/lemon-chicken?id=2",
      "https://example.org/recipes/lemon-chicken",
      "http://example.com/recipes/lemon-chicken",
    ];
    expect(new Set(pages.map(normalizeSourceUrl)).size).toBe(pages.length);
  });

  it("agrees with the link a recipe is stored with (cleanSourceUrl, then normalize)", () => {
    // The function checks the link the person sent and the link the recipe will be stored under;
    // storing a cleaned link must not change the key.
    for (const [input, expected] of LINK_CASES) {
      // Padded input is trimmed by both; an international host name becomes punycode in the URL
      // class, which the string rules do not do (the stored link is what the database sees).
      if (expected === null || /\s|[^\x21-\x7e]/.test(input)) continue;
      const stored = cleanSourceUrl(input);
      expect(normalizeSourceUrl(stored)).toBe(normalizeSourceUrl(input));
    }
  });

  it("strips every parameter cleanSourceUrl strips", () => {
    for (const name of [
      "utm_source",
      "fbclid",
      "gclid",
      "dclid",
      "msclkid",
      "mc_cid",
      "mc_eid",
      "igshid",
      "igsh",
      "ref_src",
      "_ga",
      "oly_enc_id",
    ]) {
      expect(TRACKING_PARAM.test(name)).toBe(true);
      expect(normalizeSourceUrl(`https://example.com/r?${name}=1&keep=2`)).toBe(
        "https://example.com/r?keep=2",
      );
    }
  });
});

describe("normalizeTitle", () => {
  it("folds case and spacing", () => {
    expect(normalizeTitle("  Lemon   CHICKEN \n")).toBe("lemon chicken");
    expect(normalizeTitle("Lemon\tChicken")).toBe(normalizeTitle("lemon chicken"));
  });

  it("keeps different titles apart", () => {
    expect(normalizeTitle("Lemon Chicken")).not.toBe(normalizeTitle("Lemon Roast Chicken"));
    expect(normalizeTitle("Mac & Cheese")).not.toBe(normalizeTitle("Mac and Cheese"));
  });
});

describe("titleSearchPattern", () => {
  /** Postgres ilike with the default backslash escape, for the check below. */
  function ilike(value: string, pattern: string): boolean {
    let source = "";
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i] ?? "";
      if (c === "\\") source += (pattern[++i] ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      else if (c === "%") source += "[\\s\\S]*";
      else if (c === "_") source += "[\\s\\S]";
      else source += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`^${source}$`, "i").test(value);
  }

  it("finds every spelling normalizeTitle would equal", () => {
    const pattern = titleSearchPattern("Lemon   Chicken");
    expect(pattern).toBe("lemon%chicken");
    for (const stored of ["Lemon Chicken", "lemon chicken", "LEMON\tCHICKEN", "Lemon  Chicken"]) {
      expect(ilike(stored, pattern)).toBe(true);
    }
    // A one-word title is matched whole, not as part of a longer one.
    expect(titleSearchPattern("Soup")).toBe("soup");
    expect(ilike("Soup", "soup")).toBe(true);
    expect(ilike("Tomato soup", "soup")).toBe(false);
  });

  it("may over-match; the caller compares with normalizeTitle", () => {
    expect(ilike("Lemon roast chicken", titleSearchPattern("Lemon Chicken"))).toBe(true);
    expect(normalizeTitle("Lemon roast chicken")).not.toBe(normalizeTitle("Lemon Chicken"));
  });

  it("escapes the characters ilike treats as wildcards", () => {
    expect(titleSearchPattern("100% beef_stew")).toBe("100\\%%beef\\_stew");
    expect(ilike("100% beef_stew", titleSearchPattern("100% beef_stew"))).toBe(true);
    expect(ilike("100x beefastew", titleSearchPattern("100% beef_stew"))).toBe(false);
  });
});

describe("dedupeIngredientLines", () => {
  it("keeps the first of two lines with the same text", () => {
    const lines = [
      { rawText: "2 eggs" },
      { rawText: "1 cup flour" },
      { rawText: "2 eggs" },
      { rawText: "1 cup flour" },
    ];
    expect(dedupeIngredientLines(lines)).toEqual([
      { rawText: "2 eggs" },
      { rawText: "1 cup flour" },
    ]);
  });

  it("folds whitespace before comparing, and keeps the first spelling", () => {
    const lines = [
      { rawText: "1  cup   flour" },
      { rawText: " 1 cup flour " },
      { rawText: "1\tcup flour" },
    ];
    expect(dedupeIngredientLines(lines)).toEqual([{ rawText: "1  cup   flour" }]);
  });

  it("does not fold case: lines that read differently stay", () => {
    const lines = [{ rawText: "1 Egg" }, { rawText: "1 egg" }];
    expect(dedupeIngredientLines(lines)).toHaveLength(2);
  });

  it("keeps lines that name the same ingredient with different text", () => {
    const lines = [
      { rawText: "1 tbsp butter" },
      { rawText: "2 tbsp butter, melted" },
      { rawText: "butter for the pan" },
    ];
    expect(dedupeIngredientLines(lines)).toEqual(lines);
  });

  it("keeps the same line under two headings, and drops it within one", () => {
    const lines = [
      { rawText: "1/2 tsp salt", groupName: "For the batter" },
      { rawText: "1/2 tsp salt", groupName: "For the filling" },
      { rawText: "1/2 tsp salt", groupName: "For the batter" },
      { rawText: "1/2 tsp salt" },
    ];
    expect(dedupeIngredientLines(lines)).toEqual([lines[0], lines[1], lines[3]]);
  });

  it("treats a heading that differs only in spacing as the same heading", () => {
    const lines = [
      { rawText: "salt", groupName: "For  the sauce" },
      { rawText: "salt", groupName: "For the sauce " },
    ];
    expect(dedupeIngredientLines(lines)).toHaveLength(1);
  });

  it("returns a new array in the original order and leaves its input alone", () => {
    const lines = [{ rawText: "b" }, { rawText: "a" }, { rawText: "b" }];
    const out = dedupeIngredientLines(lines);
    expect(out.map((l) => l.rawText)).toEqual(["b", "a"]);
    expect(lines).toHaveLength(3);
    expect(out).not.toBe(lines);
    expect(dedupeIngredientLines([])).toEqual([]);
  });
});
