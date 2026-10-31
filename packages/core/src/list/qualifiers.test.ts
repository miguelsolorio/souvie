import { describe, expect, it } from "vitest";
import { extractQualifiers, QUALIFIER_NAMES, withQualifiers } from "./qualifiers.ts";

describe("extractQualifiers", () => {
  it.each([
    [{ prepNote: "gluten-free" }, ["gluten-free"]],
    [{ prepNote: "Gluten Free, divided" }, ["gluten-free"]],
    [{ rawText: "8 oz gluten-free penne" }, ["gluten-free"]],
    [{ rawText: "1 cup GF flour blend" }, ["gluten-free"]],
    [{ rawText: "1 cup dairy-free milk" }, ["dairy-free"]],
    [{ rawText: "1 cup dairy‑free milk" }, ["dairy-free"]],
    [{ rawText: "2 tbsp unsalted butter" }, ["unsalted"]],
    [{ rawText: "1 can low-sodium chicken broth" }, ["low-sodium"]],
    [{ rawText: "1 can reduced sodium broth" }, ["low-sodium"]],
    [{ rawText: "1 can no salt added tomatoes" }, ["no-salt-added"]],
    [{ rawText: "1 cup unsweetened almond milk" }, ["unsweetened"]],
    [{ rawText: "1 cup nonfat yogurt" }, ["fat-free"]],
    [{ rawText: "1 cup reduced-fat sour cream" }, ["low-fat"]],
    [{ rawText: "1 tbsp vegan mayo" }, ["vegan"]],
    [{ rawText: "peanut-free granola, nut free" }, ["nut-free", "peanut-free"]],
    [
      { prepNote: "gluten-free", rawText: "1 cup unsalted gluten free broth" },
      ["gluten-free", "unsalted"],
    ],
  ])("%j", (args, expected) => {
    expect(extractQualifiers(args)).toEqual(expected);
  });

  it("is empty for preparation words and plain lines", () => {
    expect(extractQualifiers({ prepNote: "diced", rawText: "1 cup diced onion" })).toEqual([]);
    expect(extractQualifiers({ prepNote: null, rawText: "1 lb chicken, cut into pieces" })).toEqual(
      [],
    );
    expect(extractQualifiers({})).toEqual([]);
  });

  it("does not read a qualifier out of a longer word", () => {
    expect(extractQualifiers({ rawText: "sugar free-range eggs" })).toEqual([]);
    expect(extractQualifiers({ rawText: "1 cup veganaise" })).toEqual([]);
    expect(extractQualifiers({ rawText: "2 gfruit" })).toEqual([]);
  });

  it("drops a qualifier the ingredient's own name already says", () => {
    expect(
      extractQualifiers({ rawText: "1 stick unsalted butter", ingredientName: "unsalted butter" }),
    ).toEqual([]);
    expect(
      extractQualifiers({ rawText: "1 stick unsalted butter", ingredientName: "butter" }),
    ).toEqual(["unsalted"]);
  });

  it("returns names from the closed vocabulary, sorted", () => {
    const all = extractQualifiers({
      rawText: "vegan gluten-free unsalted dairy-free low-sodium",
    });
    expect(all).toEqual([...all].sort());
    for (const name of all) expect(QUALIFIER_NAMES).toContain(name);
  });
});

describe("withQualifiers", () => {
  it("writes them after the name", () => {
    expect(withQualifiers("Penne", [])).toBe("Penne");
    expect(withQualifiers("Penne", ["gluten-free"])).toBe("Penne (gluten-free)");
    expect(withQualifiers("Broth", ["low-sodium", "unsalted"])).toBe(
      "Broth (low-sodium, unsalted)",
    );
  });
});
