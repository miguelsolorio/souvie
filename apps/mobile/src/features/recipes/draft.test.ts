import type { RecipeWithIngredients } from "@mp/core";
import { describe, expect, it } from "vitest";
import {
  draftFromForm,
  draftFromNormalized,
  draftFromRecipe,
  emptyForm,
  existingLines,
  formErrors,
  formFromDraft,
  hasErrors,
  ingredientsToText,
  isSectionHeading,
  parseAmount,
  parseMinutes,
  stepsToText,
  tagsToText,
  textToIngredients,
  textToSteps,
  textToTags,
} from "./draft";

const RECIPE: RecipeWithIngredients = {
  id: "5ec1be00-0000-4000-8000-000000000001",
  household_id: "0a000000-0000-4000-8000-00000000000a",
  title: "Lemon Chicken",
  description: "Quick.",
  image_url: "https://example.test/a.jpg",
  source_type: "url",
  source_url: "https://example.test/r",
  servings: 4,
  prep_min: 10,
  cook_min: 35,
  instructions: [
    { step: 2, text: "Roast." },
    { step: 1, text: "Heat the oven." },
  ],
  nutrition: { calories: "320 kcal" },
  tags: ["dinner", "chicken"],
  cuisine: "american",
  visibility: "household",
  created_by: null,
  created_at: "2026-10-30T07:12:14.123456+00:00",
  updated_at: "2026-10-30T07:12:14.123456+00:00",
  deleted_at: null,
  ingredients: [
    line("l1", 0, null, "8 chicken thighs"),
    line("l2", 1, "For the pan", "1 lemon, sliced"),
    line("l3", 2, "For the pan", "2 cloves garlic"),
    line("l4", 3, null, "salt"),
  ],
};

function line(id: string, position: number, group: string | null, text: string) {
  return {
    id,
    recipe_id: "5ec1be00-0000-4000-8000-000000000001",
    position,
    group_name: group,
    raw_text: text,
    qty: null,
    qty_max: null,
    unit: null,
    ingredient_id: null,
    prep_note: null,
    optional: false,
    parse_confidence: null,
  };
}

describe("ingredient text", () => {
  it("writes a heading whenever the section changes, including back to none", () => {
    expect(
      ingredientsToText([
        { rawText: "a" },
        { rawText: "b", groupName: "Sauce" },
        { rawText: "c", groupName: "Sauce" },
        { rawText: "d" },
      ]),
    ).toBe("a\n# Sauce\nb\nc\n#\nd");
  });

  it("reads headings, skips blank lines, and trims", () => {
    expect(textToIngredients("  a  \n\n# Sauce\nb\n\nc\n#\nd")).toEqual([
      { rawText: "a" },
      { rawText: "b", groupName: "Sauce" },
      { rawText: "c", groupName: "Sauce" },
      { rawText: "d" },
    ]);
  });

  it("round-trips", () => {
    const items = [{ rawText: "a" }, { rawText: "b", groupName: "Sauce" }, { rawText: "c" }];
    expect(textToIngredients(ingredientsToText(items))).toEqual(items);
  });

  it("reads a # as a heading only when a space and a name follow it", () => {
    expect(isSectionHeading("# For the sauce")).toBe(true);
    expect(isSectionHeading("## For the sauce")).toBe(true);
    expect(isSectionHeading("#")).toBe(true);
    expect(isSectionHeading("#10 can tomato paste")).toBe(false);
    expect(isSectionHeading("#2 can crushed tomatoes")).toBe(false);
    expect(isSectionHeading("#sauce")).toBe(false);
  });

  it("keeps a line that starts with # but is not a heading, such as a can size", () => {
    expect(textToIngredients("#10 can tomato paste\n#2 can beans\n# For the pan\n#sauce")).toEqual([
      { rawText: "#10 can tomato paste" },
      { rawText: "#2 can beans" },
      { rawText: "#sauce", groupName: "For the pan" },
    ]);
  });

  it("round-trips a can-size line and a section that starts with a digit", () => {
    const items = [
      { rawText: "#10 can tomato paste" },
      { rawText: "1 tsp five-spice", groupName: "5-Spice marinade" },
      { rawText: "#2 can beans", groupName: "5-Spice marinade" },
      { rawText: "salt" },
    ];
    const text = ingredientsToText(items);
    expect(textToIngredients(text)).toEqual(items);
    expect(ingredientsToText(textToIngredients(text))).toBe(text);
  });

  it("keeps the id of a line left alone and gives a changed line none", () => {
    const previous = existingLines(RECIPE);
    const edited = textToIngredients(
      "8 chicken thighs\n# For the pan\n2 lemons, sliced\n2 cloves garlic\n#\nsalt\npepper",
      previous,
    );
    expect(edited).toEqual([
      { id: "l1", rawText: "8 chicken thighs" },
      { rawText: "2 lemons, sliced", groupName: "For the pan" },
      { id: "l3", rawText: "2 cloves garlic", groupName: "For the pan" },
      { id: "l4", rawText: "salt" },
      { rawText: "pepper" },
    ]);
  });

  it("does not hand one id to two lines with the same text", () => {
    const previous = [{ id: "x", rawText: "salt" }];
    expect(textToIngredients("salt\nsalt", previous)).toEqual([
      { id: "x", rawText: "salt" },
      { rawText: "salt" },
    ]);
  });

  it("treats a line as new when it moves to another section", () => {
    const previous = [{ id: "x", rawText: "salt", groupName: "Sauce" }];
    expect(textToIngredients("salt", previous)).toEqual([{ rawText: "salt" }]);
  });
});

describe("steps and tags", () => {
  it("writes steps as paragraphs and reads any newline as a step break", () => {
    expect(stepsToText(["Heat.", "Roast."])).toBe("Heat.\n\nRoast.");
    expect(textToSteps("Heat.\n\n  Roast.  \r\nServe.\n")).toEqual(["Heat.", "Roast.", "Serve."]);
  });

  it("round-trips steps, including one with a line break inside, without splitting it", () => {
    const steps = ["Heat the oven.", "Mix the batter.\n\nLet it rest for ten minutes.", "Serve."];
    const once = textToSteps(stepsToText(steps));
    // The break inside the second step becomes a space; the step count does not change.
    expect(once).toEqual([
      "Heat the oven.",
      "Mix the batter. Let it rest for ten minutes.",
      "Serve.",
    ]);
    // From then on the round trip is stable, in both directions.
    expect(textToSteps(stepsToText(once))).toEqual(once);
    expect(stepsToText(textToSteps(stepsToText(once)))).toBe(stepsToText(once));
  });

  it("leaves single-paragraph steps exactly as they were", () => {
    const steps = ["Heat.", "Roast for 30 - 40 minutes.", "Serve."];
    expect(textToSteps(stepsToText(steps))).toEqual(steps);
    expect(stepsToText(["a\r\nb  \n  c"])).toBe("a b c");
  });

  it("lowercases, trims, and dedupes tags", () => {
    expect(textToTags(" Dinner, chicken ,DINNER,, ")).toEqual(["dinner", "chicken"]);
    expect(tagsToText(["a", "b"])).toBe("a, b");
    expect(tagsToText(undefined)).toBe("");
  });
});

describe("numbers", () => {
  it("parses amounts", () => {
    expect(parseAmount("4")).toBe(4);
    expect(parseAmount("4.5")).toBe(4.5);
    expect(parseAmount("1/2")).toBe(0.5);
    expect(parseAmount("1 1/2")).toBe(1.5);
    expect(parseAmount("")).toBeUndefined();
    expect(parseAmount("four")).toBeUndefined();
    expect(parseAmount("1/0")).toBeUndefined();
  });

  it("parses whole minutes only", () => {
    expect(parseMinutes("35")).toBe(35);
    expect(parseMinutes(" 0 ")).toBe(0);
    expect(parseMinutes("1.5")).toBeUndefined();
    expect(parseMinutes("-3")).toBeUndefined();
    expect(parseMinutes("")).toBeUndefined();
  });
});

describe("recipe to form and back", () => {
  it("shows a stored recipe in the form with sorted steps and headed ingredients", () => {
    const form = formFromDraft(draftFromRecipe(RECIPE));
    expect(form).toMatchObject({
      title: "Lemon Chicken",
      servings: "4",
      prepMin: "10",
      cookMin: "35",
      cuisine: "american",
      tags: "dinner, chicken",
      imageUrl: "https://example.test/a.jpg",
      steps: "Heat the oven.\n\nRoast.",
      ingredients: "8 chicken thighs\n# For the pan\n1 lemon, sliced\n2 cloves garlic\n#\nsalt",
    });
  });

  it("saving an untouched form gives back the same lines with their ids", () => {
    const form = formFromDraft(draftFromRecipe(RECIPE));
    const draft = draftFromForm(form, existingLines(RECIPE));
    expect(draft.ingredients.map((i) => i.id)).toEqual(["l1", "l2", "l3", "l4"]);
    expect(draft.title).toBe("Lemon Chicken");
    expect(draft.servings).toBe(4);
    expect(draft.nutrition).toEqual({ calories: "320 kcal" });
    expect(draft.instructions).toEqual(["Heat the oven.", "Roast."]);
  });

  it("turns a normalized import into a draft without ids", () => {
    const draft = draftFromNormalized({
      title: "Pancakes",
      sourceUrl: "https://example.test/p",
      ingredients: [{ rawText: "2 cups flour", groupName: "Batter" }, { rawText: "1 egg" }],
      instructions: ["Whisk."],
      tags: ["breakfast"],
    });
    expect(draft.ingredients).toEqual([
      { rawText: "2 cups flour", groupName: "Batter" },
      { rawText: "1 egg" },
    ]);
    expect(draft.tags).toEqual(["breakfast"]);
  });

  it("leaves blank optional fields undefined", () => {
    const draft = draftFromForm({ ...emptyForm(), title: "x", ingredients: "a" });
    expect(draft).toMatchObject({
      description: undefined,
      servings: undefined,
      cuisine: undefined,
    });
    expect(draft.tags).toEqual([]);
  });
});

describe("formErrors", () => {
  it("accepts a complete form", () => {
    expect(
      hasErrors(formErrors({ ...emptyForm(), title: "Soup", ingredients: "2 cups stock" })),
    ).toBe(false);
  });

  it("asks for a title and an ingredient", () => {
    const errors = formErrors(emptyForm());
    expect(errors.title).toMatch(/title/);
    expect(errors.ingredients).toMatch(/ingredient/);
  });

  it("flags unreadable numbers, naming the field", () => {
    const errors = formErrors({
      ...emptyForm(),
      title: "x",
      ingredients: "a",
      servings: "lots",
      prepMin: "1.5",
      cookMin: "20",
    });
    expect(errors.servings).toBeDefined();
    expect(errors.prepMin).toBeDefined();
    expect(errors.cookMin).toBeUndefined();
    expect(
      formErrors({ ...emptyForm(), title: "x", ingredients: "a", servings: "5000" }).servings,
    ).toMatch(/too many/);
  });

  it("only sections without any ingredient text count as no ingredients", () => {
    expect(
      formErrors({ ...emptyForm(), title: "x", ingredients: "# Sauce\n\n#" }).ingredients,
    ).toBeDefined();
  });

  describe("for the Write tab, which wants whole servings", () => {
    const base = { ...emptyForm(), title: "Soup", ingredients: "2 cups stock" };
    const whole = { wholeServings: true };

    it("accepts a whole number, and no servings at all", () => {
      expect(formErrors({ ...base, servings: "4" }, whole).servings).toBeUndefined();
      expect(formErrors({ ...base, servings: " 12 " }, whole).servings).toBeUndefined();
      expect(formErrors(base, whole).servings).toBeUndefined();
      expect(hasErrors(formErrors({ ...base, servings: "6" }, whole))).toBe(false);
    });

    it("asks for a whole number when it is anything else", () => {
      for (const servings of ["1 1/2", "1/2", "4.5", "0", "00", "-2", "lots", "4 people", "1e3"]) {
        expect(formErrors({ ...base, servings }, whole).servings, servings).toBe(
          "Use a whole number such as 4.",
        );
      }
    });

    it("still stops at the limit", () => {
      expect(formErrors({ ...base, servings: "5000" }, whole).servings).toMatch(/too many/);
    });

    it("still asks for a title and an ingredient", () => {
      const errors = formErrors({ ...emptyForm(), servings: "4" }, whole);
      expect(errors.title).toMatch(/title/);
      expect(errors.ingredients).toMatch(/ingredient/);
    });

    it("leaves every other form alone: an imported 1 1/2 or 4.5 still saves", () => {
      for (const servings of ["1 1/2", "4.5", "1/2"]) {
        expect(formErrors({ ...base, servings }).servings, servings).toBeUndefined();
        expect(
          formErrors({ ...base, servings }, { wholeServings: false }).servings,
        ).toBeUndefined();
      }
      expect(formErrors({ ...base, servings: "0" }).servings).toBe(
        "Use a number such as 4 or 1 1/2.",
      );
    });
  });
});
