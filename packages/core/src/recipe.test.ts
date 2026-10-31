import { describe, expect, it } from "vitest";
import {
  HttpUrl,
  IMPORT_ERROR_CODES,
  IMPORT_ERROR_MESSAGES,
  ImportRecipeRequest,
  ImportRecipeResponse,
  instructionsToJson,
  instructionsToSteps,
  NormalizedRecipe,
  Recipe,
  RecipeIngredient,
  recipeSourceDomain,
} from "./recipe.ts";

const EXAMPLE = {
  title: "Weeknight Chicken Thighs with Lemon and Garlic",
  sourceUrl: "https://example.com/recipes/lemon-garlic-chicken",
  servings: 4,
  prepMin: 10,
  cookMin: 35,
  ingredients: [
    { rawText: "8 bone-in chicken thighs" },
    { rawText: "4 cloves garlic, smashed" },
    { rawText: "1 lemon, sliced", groupName: "For the pan" },
  ],
  instructions: ["Heat the oven to 425F.", "Season the thighs...", "Roast 35 minutes."],
  tags: ["weeknight", "chicken"],
  cuisine: "american",
};

describe("NormalizedRecipe", () => {
  it("accepts the example from the brief", () => {
    expect(NormalizedRecipe.parse(EXAMPLE)).toEqual(EXAMPLE);
  });

  it("trims text", () => {
    const parsed = NormalizedRecipe.parse({
      title: "  Soup  ",
      ingredients: [{ rawText: "  2 cups water " }],
      instructions: [" Boil. "],
    });
    expect(parsed.title).toBe("Soup");
    expect(parsed.ingredients[0]?.rawText).toBe("2 cups water");
    expect(parsed.instructions).toEqual(["Boil."]);
  });

  it("needs a title and at least one ingredient", () => {
    expect(NormalizedRecipe.safeParse({ ...EXAMPLE, title: " " }).success).toBe(false);
    expect(NormalizedRecipe.safeParse({ ...EXAMPLE, ingredients: [] }).success).toBe(false);
  });

  it("allows a recipe with no steps, since a typed-in or captioned recipe may lack them", () => {
    expect(NormalizedRecipe.safeParse({ ...EXAMPLE, instructions: [] }).success).toBe(true);
  });

  it("rejects non-web source links", () => {
    for (const sourceUrl of ["javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd"]) {
      expect(NormalizedRecipe.safeParse({ ...EXAMPLE, sourceUrl }).success, sourceUrl).toBe(false);
    }
  });

  it("accepts an http image or a storage path and rejects other schemes", () => {
    for (const imageUrl of [
      "https://example.com/a.jpg",
      "0a000000-0000-4000-8000-00000000000a/card.jpg",
    ]) {
      expect(NormalizedRecipe.safeParse({ ...EXAMPLE, imageUrl }).success, imageUrl).toBe(true);
    }
    for (const imageUrl of [
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      "file:///etc/passwd",
    ]) {
      expect(NormalizedRecipe.safeParse({ ...EXAMPLE, imageUrl }).success, imageUrl).toBe(false);
    }
  });

  it("rejects out-of-range numbers", () => {
    expect(NormalizedRecipe.safeParse({ ...EXAMPLE, servings: 0 }).success).toBe(false);
    expect(NormalizedRecipe.safeParse({ ...EXAMPLE, prepMin: -1 }).success).toBe(false);
    expect(NormalizedRecipe.safeParse({ ...EXAMPLE, cookMin: 1.5 }).success).toBe(false);
  });
});

describe("recipeSourceDomain", () => {
  it("returns the host without www", () => {
    expect(recipeSourceDomain("https://www.seriouseats.com/recipes/2020/a-b")).toBe(
      "seriouseats.com",
    );
    expect(recipeSourceDomain("http://Cooking.NYTimes.com/x")).toBe("cooking.nytimes.com");
    expect(recipeSourceDomain("https://user:pw@example.com:8080/x")).toBe("example.com");
  });

  it("returns null for nothing or a non-web value", () => {
    expect(recipeSourceDomain(null)).toBeNull();
    expect(recipeSourceDomain("")).toBeNull();
    expect(recipeSourceDomain("mailto:a@b.c")).toBeNull();
  });
});

describe("HttpUrl", () => {
  it("accepts http and https and nothing else", () => {
    expect(HttpUrl.safeParse("https://example.com/a?b=c").success).toBe(true);
    expect(HttpUrl.safeParse("http://example.com").success).toBe(true);
    expect(HttpUrl.safeParse("ftp://example.com").success).toBe(false);
    expect(HttpUrl.safeParse("https://exa mple.com").success).toBe(false);
  });
});

describe("instructions mapping", () => {
  it("numbers steps from 1 and reads them back in order", () => {
    const json = instructionsToJson(["a", "b", "c"]);
    expect(json).toEqual([
      { step: 1, text: "a" },
      { step: 2, text: "b" },
      { step: 3, text: "c" },
    ]);
    expect(instructionsToSteps([...json].reverse())).toEqual(["a", "b", "c"]);
  });
});

describe("ImportRecipeRequest", () => {
  it("accepts each kind", () => {
    expect(
      ImportRecipeRequest.safeParse({ kind: "url", input: "https://example.com/r" }).success,
    ).toBe(true);
    expect(
      ImportRecipeRequest.safeParse({ kind: "text", input: "Pancakes\n2 cups flour\n1 egg\nMix." })
        .success,
    ).toBe(true);
    expect(
      ImportRecipeRequest.safeParse({
        kind: "image",
        input: { path: "0a000000-0000-4000-8000-00000000000a/card.jpg" },
        save: false,
      }).success,
    ).toBe(true);
    expect(
      ImportRecipeRequest.safeParse({
        kind: "caption",
        input: "Easy pasta\n1 lb pasta\n2 cloves garlic",
        sourceUrl: "https://www.tiktok.com/@a/video/1",
      }).success,
    ).toBe(true);
  });

  it("rejects a bad URL, a short text, and an unknown kind", () => {
    expect(
      ImportRecipeRequest.safeParse({ kind: "url", input: "javascript:alert(1)" }).success,
    ).toBe(false);
    expect(ImportRecipeRequest.safeParse({ kind: "text", input: "hi" }).success).toBe(false);
    expect(ImportRecipeRequest.safeParse({ kind: "video", input: "x" }).success).toBe(false);
  });
});

describe("ImportRecipeResponse", () => {
  it("parses a saved recipe and a failure", () => {
    expect(
      ImportRecipeResponse.safeParse({
        ok: true,
        jobId: "0a000000-0000-4000-8000-00000000000a",
        path: "jsonld",
        recipeId: "0b000000-0000-4000-8000-00000000000b",
        warnings: [],
      }).success,
    ).toBe(true);
    expect(ImportRecipeResponse.safeParse({ ok: false, error: "blocked" }).success).toBe(true);
    expect(ImportRecipeResponse.safeParse({ ok: false, error: "nope" }).success).toBe(false);
  });

  it("has a message for every error code", () => {
    for (const code of IMPORT_ERROR_CODES) expect(IMPORT_ERROR_MESSAGES[code], code).toBeTruthy();
  });
});

describe("row schemas", () => {
  it("parse what PostgREST returns", () => {
    const recipe = {
      id: "0a000000-0000-4000-8000-00000000000a",
      household_id: "0b000000-0000-4000-8000-00000000000b",
      title: "Soup",
      description: null,
      image_url: null,
      source_type: "manual",
      source_url: null,
      servings: 4,
      prep_min: null,
      cook_min: 20,
      instructions: [{ step: 1, text: "Boil." }],
      nutrition: null,
      tags: [],
      cuisine: null,
      visibility: "household",
      created_by: null,
      created_at: "2026-10-30T07:12:14.123456+00:00",
      updated_at: "2026-10-30T07:12:14.123456+00:00",
      deleted_at: null,
    };
    expect(Recipe.safeParse(recipe).success).toBe(true);
    expect(
      RecipeIngredient.safeParse({
        id: "0c000000-0000-4000-8000-00000000000c",
        recipe_id: recipe.id,
        position: 0,
        group_name: null,
        raw_text: "2 cups water",
        qty: null,
        qty_max: null,
        unit: null,
        ingredient_id: null,
        prep_note: null,
        optional: false,
        parse_confidence: null,
      }).success,
    ).toBe(true);
  });

  it("accepts the CCR5 container columns and rejects a zero count", () => {
    const line = {
      id: "0c000000-0000-4000-8000-00000000000c",
      recipe_id: "0a000000-0000-4000-8000-00000000000a",
      position: 0,
      group_name: null,
      raw_text: "2 (14 oz) cans diced tomatoes",
      qty: 28,
      qty_max: null,
      unit: "oz",
      ingredient_id: null,
      prep_note: null,
      optional: false,
      parse_confidence: 0.9,
    };
    expect(
      RecipeIngredient.safeParse({ ...line, container_count: 2, container: "can" }).success,
    ).toBe(true);
    expect(
      RecipeIngredient.safeParse({ ...line, container_count: null, container: null }).success,
    ).toBe(true);
    expect(
      RecipeIngredient.safeParse({ ...line, container_count: 0, container: "can" }).success,
    ).toBe(false);
  });
});
