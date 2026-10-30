import type { RecipeExtractOutput } from "@mp/llm";
import { describe, expect, it } from "vitest";
import {
  cleanImageUrl,
  cleanIngredientLine,
  cleanSourceUrl,
  cleanStep,
  decodeEntities,
  normalizeModelOutput,
  normalizeScraped,
  parseServings,
  recipeWarnings,
  restoreRepeatedLines,
  type ScrapedRecipe,
} from "./normalize.ts";

const scraped = (over: Partial<ScrapedRecipe> = {}): ScrapedRecipe => ({
  title: "Lemon Chicken",
  description: "Bright and quick.",
  image: "https://example.com/a.jpg",
  yields: "4 servings",
  prepTime: 10,
  cookTime: 35,
  totalTime: 45,
  ingredients: [
    { name: null, items: [{ value: "8 chicken thighs" }, { value: "1 lemon, sliced" }] },
  ],
  instructions: [{ name: null, items: [{ value: "Heat the oven." }, { value: "Roast." }] }],
  nutrients: { calories: "320 kcal" },
  keywords: ["Weeknight", "chicken"],
  category: ["Dinner"],
  cuisine: ["American"],
  ...over,
});

describe("normalizeScraped", () => {
  it("maps a scraped recipe to a NormalizedRecipe", () => {
    const recipe = normalizeScraped(scraped(), "https://example.com/r?utm_source=x#top");
    expect(recipe).toEqual({
      title: "Lemon Chicken",
      description: "Bright and quick.",
      imageUrl: "https://example.com/a.jpg",
      sourceUrl: "https://example.com/r",
      servings: 4,
      prepMin: 10,
      cookMin: 35,
      ingredients: [{ rawText: "8 chicken thighs" }, { rawText: "1 lemon, sliced" }],
      instructions: ["Heat the oven.", "Roast."],
      nutrition: { calories: "320 kcal" },
      tags: ["dinner", "weeknight", "chicken"],
      cuisine: "american",
    });
  });

  it("keeps section names as groupName, but not a generic 'Ingredients' label", () => {
    const recipe = normalizeScraped(
      scraped({
        ingredients: [
          { name: "For the sauce:", items: [{ value: "1 cup stock" }] },
          { name: "Ingredients", items: [{ value: "2 eggs" }] },
          { name: null, items: [{ value: "salt" }] },
        ],
      }),
      "https://example.com/r",
    );
    expect(recipe?.ingredients).toEqual([
      { rawText: "1 cup stock", groupName: "For the sauce" },
      { rawText: "2 eggs" },
      { rawText: "salt" },
    ]);
  });

  it("drops bullets, numbering, and blank lines, and clamps long lines", () => {
    const long = "x".repeat(900);
    const recipe = normalizeScraped(
      scraped({
        ingredients: [
          { name: null, items: [{ value: "• 2 cups flour" }, { value: "  " }, { value: long }] },
        ],
        instructions: [{ name: null, items: [{ value: "1. Mix." }, { value: "Step 2: Bake." }] }],
      }),
      "https://example.com/r",
    );
    expect(recipe?.ingredients[0]?.rawText).toBe("2 cups flour");
    expect(recipe?.ingredients).toHaveLength(2);
    expect(recipe?.ingredients[1]?.rawText).toHaveLength(500);
    expect(recipe?.instructions).toEqual(["Mix.", "Bake."]);
  });

  it("ignores a non-http image and an unusable yield and time", () => {
    const recipe = normalizeScraped(
      scraped({
        image: "data:image/png;base64,AAAA",
        yields: "Yield not specified",
        prepTime: null,
        cookTime: -3,
      }),
      "https://example.com/r",
    );
    expect(recipe).not.toHaveProperty("imageUrl");
    expect(recipe).not.toHaveProperty("servings");
    expect(recipe).not.toHaveProperty("prepMin");
    expect(recipe).not.toHaveProperty("cookMin");
  });

  it("returns null when there is no title or no ingredient", () => {
    expect(normalizeScraped(scraped({ title: "  " }), "https://example.com/r")).toBeNull();
    expect(
      normalizeScraped(
        scraped({ ingredients: [{ name: null, items: [] }] }),
        "https://example.com/r",
      ),
    ).toBeNull();
  });

  it("restores repeated lines the library dropped, using the page's own list", () => {
    const recipe = normalizeScraped(
      scraped({
        ingredients: [
          { name: "Batter", items: [{ value: "1/2 teaspoon salt" }, { value: "2 cups flour" }] },
          { name: "Filling", items: [{ value: "1 cup sugar" }] },
        ],
      }),
      "https://example.com/r",
      {
        referenceIngredients: [
          "2 cups flour",
          "1/2 teaspoon salt",
          "1 cup sugar",
          "1/2 teaspoon salt",
        ],
      },
    );
    expect(recipe?.ingredients.map((i) => i.rawText)).toEqual([
      "1/2 teaspoon salt",
      "1/2 teaspoon salt",
      "2 cups flour",
      "1 cup sugar",
    ]);
  });
});

describe("restoreRepeatedLines", () => {
  const lines = [{ rawText: "1 egg" }, { rawText: "salt" }];

  it("adds each missing repeat once, after the first copy", () => {
    expect(restoreRepeatedLines(lines, ["1 egg", "1 egg", "1 egg", "salt"])).toEqual([
      { rawText: "1 egg" },
      { rawText: "1 egg" },
      { rawText: "1 egg" },
      { rawText: "salt" },
    ]);
  });

  it("compares decoded, case-insensitive text and never invents lines", () => {
    expect(
      restoreRepeatedLines([{ rawText: "1 tsp. salt & pepper" }], ["1 TSP. salt &amp; pepper"]),
    ).toEqual([{ rawText: "1 tsp. salt & pepper" }]);
    expect(restoreRepeatedLines(lines, ["something else", "something else"])).toEqual(lines);
  });
});

describe("normalizeModelOutput", () => {
  const output = (over: Partial<RecipeExtractOutput> = {}): RecipeExtractOutput => ({
    found: true,
    title: "Pancakes",
    description: null,
    servings: 4,
    prep_minutes: 5,
    cook_minutes: 10,
    ingredients: [
      { text: "2 cups flour", group: null },
      { text: "1 cup milk", group: "Batter" },
    ],
    steps: ["Mix.", "Fry."],
    tags: ["Breakfast", "breakfast", " Quick "],
    cuisine: "American",
    ...over,
  });

  it("maps the model's answer and takes the image and source from the page", () => {
    const recipe = normalizeModelOutput(output(), {
      sourceUrl: "https://example.com/p?fbclid=1",
      imageUrl: "//cdn.example.com/p.jpg",
    });
    expect(recipe).toEqual({
      title: "Pancakes",
      imageUrl: "https://cdn.example.com/p.jpg",
      sourceUrl: "https://example.com/p",
      servings: 4,
      prepMin: 5,
      cookMin: 10,
      ingredients: [{ rawText: "2 cups flour" }, { rawText: "1 cup milk", groupName: "Batter" }],
      instructions: ["Mix.", "Fry."],
      tags: ["breakfast", "quick"],
      cuisine: "american",
    });
  });

  it("returns null when the model found no recipe or gave nothing usable", () => {
    expect(normalizeModelOutput(output({ found: false }))).toBeNull();
    expect(normalizeModelOutput(output({ ingredients: [] }))).toBeNull();
    expect(normalizeModelOutput(output({ title: " " }))).toBeNull();
  });

  it("drops impossible numbers instead of failing the recipe", () => {
    const recipe = normalizeModelOutput(
      output({ servings: -2, prep_minutes: 999999, cook_minutes: null }),
    );
    expect(recipe).not.toHaveProperty("servings");
    expect(recipe).not.toHaveProperty("prepMin");
    expect(recipe).not.toHaveProperty("cookMin");
  });
});

describe("helpers", () => {
  it("cleanSourceUrl strips tracking parameters and the fragment, and keeps real ones", () => {
    expect(cleanSourceUrl("https://a.com/r?id=7&utm_medium=email&gclid=1#x")).toBe(
      "https://a.com/r?id=7",
    );
    expect(cleanSourceUrl("  https://a.com/r  ")).toBe("https://a.com/r");
    expect(cleanSourceUrl("not a url")).toBe("not a url");
  });

  it("parseServings reads the first number", () => {
    expect(parseServings("4 servings")).toBe(4);
    expect(parseServings("Makes 12 cookies")).toBe(12);
    expect(parseServings("4-6 servings")).toBe(4);
    expect(parseServings("0 servings")).toBeUndefined();
    expect(parseServings("a few")).toBeUndefined();
    expect(parseServings(null)).toBeUndefined();
  });

  it("cleanImageUrl accepts http(s) and protocol-relative links only", () => {
    expect(cleanImageUrl("//x.com/a.jpg")).toBe("https://x.com/a.jpg");
    expect(cleanImageUrl("http://x.com/a.jpg")).toBe("http://x.com/a.jpg");
    expect(cleanImageUrl("javascript:alert(1)")).toBeUndefined();
    expect(cleanImageUrl("/relative.jpg")).toBeUndefined();
    expect(cleanImageUrl("")).toBeUndefined();
  });

  it("cleans list marks and step numbers", () => {
    expect(cleanIngredientLine("☐  1 cup rice")).toBe("1 cup rice");
    expect(cleanIngredientLine("- 1 cup rice")).toBe("1 cup rice");
    expect(cleanStep("2) Stir.")).toBe("Stir.");
    expect(cleanStep("Step 3: Serve.")).toBe("Serve.");
    expect(cleanStep("350 degrees for an hour")).toBe("350 degrees for an hour");
  });

  it("strips a step label but keeps a number that is part of the sentence", () => {
    // Labels.
    expect(cleanStep("1. Preheat the oven.")).toBe("Preheat the oven.");
    expect(cleanStep("10. Cool on a rack.")).toBe("Cool on a rack.");
    expect(cleanStep("3: Fold in the eggs.")).toBe("Fold in the eggs.");
    expect(cleanStep("- 4) Serve warm.")).toBe("Serve warm.");
    expect(cleanStep("Step 2 - Whisk.")).toBe("Whisk.");
    expect(cleanStep("step 7. Rest.")).toBe("Rest.");
    expect(cleanStep("Step 1 Mix everything.")).toBe("Mix everything.");
    // Numbers that are not labels: a spaced range, a bare quantity, a decimal, a temperature.
    expect(cleanStep("30 - 40 minutes in the oven until golden.")).toBe(
      "30 - 40 minutes in the oven until golden.",
    );
    expect(cleanStep("30 – 40 minutes in the oven.")).toBe("30 – 40 minutes in the oven.");
    expect(cleanStep("30-40 minutes in the oven.")).toBe("30-40 minutes in the oven.");
    expect(cleanStep("2 : 1 ratio of water to rice.")).toBe("2 : 1 ratio of water to rice.");
    expect(cleanStep("1.5 cups of stock go in next.")).toBe("1.5 cups of stock go in next.");
    expect(cleanStep("350. Bake until set.")).toBe("350. Bake until set.");
    expect(cleanStep("Step up the heat to high.")).toBe("Step up the heat to high.");
  });

  it("decodes numeric and named entities", () => {
    expect(decodeEntities("a &amp; b &#8211; c &#x2019;s &quot;d&quot; &nope;")).toBe(
      'a & b – c ’s "d" &nope;',
    );
    expect(decodeEntities("&#99999999999;")).toBe("&#99999999999;");
  });

  it("recipeWarnings flags thin recipes", () => {
    expect(
      recipeWarnings({ title: "x", ingredients: [{ rawText: "a" }], instructions: [] }),
    ).toEqual(["no_instructions", "few_ingredients"]);
    expect(
      recipeWarnings({
        title: "x",
        ingredients: [{ rawText: "a" }, { rawText: "b" }],
        instructions: ["s"],
      }),
    ).toEqual([]);
  });
});
