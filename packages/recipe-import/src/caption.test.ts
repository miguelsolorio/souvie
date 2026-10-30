import { describe, expect, it, vi } from "vitest";
import { importFromCaption } from "./caption.ts";
import type { ModelExtract } from "./schema.ts";
import {
  hasEnoughCaptionText,
  ingredientLikeLines,
  MIN_INGREDIENT_LINES,
  splitSharedText,
} from "./share.ts";

const PASTA_CAPTION = `Creamy garlic pasta in 15 minutes \u{1F35D}\u{1F525}

Ingredients:
\u{1F538} 8 oz spaghetti
\u{1F538} 4 cloves garlic, minced
\u{1F538} 1/2 cup heavy cream
\u{1F538} Salt and pepper to taste
\u{1F538} a handful of parsley

1. Boil the pasta.
2. Sauté the garlic, add cream.
3. Toss and serve.

Follow @cooksimple for more!
#pasta #dinnerideas #foodtok`;

const NO_RECIPE_CAPTION = `Date night at home \u{1F495}✨
So good, you need to try this one!!
Link in bio \u{1F447}
#foodie #yum #fyp @friend`;

const model = () => {
  const extract: ModelExtract = vi.fn(async (schema) => ({
    value: schema.parse({
      found: true,
      title: "Creamy Garlic Pasta",
      description: null,
      servings: null,
      prep_minutes: null,
      cook_minutes: 15,
      ingredients: [
        { text: "8 oz spaghetti", group: null },
        { text: "4 cloves garlic, minced", group: null },
        { text: "1/2 cup heavy cream", group: null },
      ],
      steps: ["Boil the pasta.", "Saute the garlic, add cream.", "Toss and serve."],
      tags: ["pasta"],
      cuisine: null,
    }),
    model: "claude-sonnet-5-5",
    attempts: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
  })) as never;
  return extract;
};

describe("ingredientLikeLines", () => {
  it("finds ingredient lines in a real-looking caption and skips steps, hashtags, and chatter", () => {
    const lines = ingredientLikeLines(PASTA_CAPTION);
    expect(lines).toEqual([
      "8 oz spaghetti",
      "4 cloves garlic, minced",
      "1/2 cup heavy cream",
      "Salt and pepper to taste",
      "a handful of parsley",
    ]);
  });

  it("finds none in a caption that is only talk and hashtags", () => {
    expect(ingredientLikeLines(NO_RECIPE_CAPTION)).toEqual([]);
    expect(hasEnoughCaptionText(NO_RECIPE_CAPTION)).toBe(false);
  });

  it("does not mistake numbered steps or times for ingredients", () => {
    const steps =
      "1. Preheat the oven\n2) Mix the batter\n10 minutes later, flip\n20 min in the oven\nStep 3: serve";
    expect(ingredientLikeLines(steps)).toEqual([]);
  });

  it("reads amounts in several styles", () => {
    const caption = [
      "2 eggs",
      "1 1/2 cups flour",
      "½ tsp salt",
      "two cloves garlic",
      "200g butter",
      "a pinch of nutmeg",
      "olive oil, to taste",
    ].join("\n");
    expect(ingredientLikeLines(caption)).toHaveLength(7);
  });

  it("counts a run of three short bulleted lines as an ingredient list without amounts", () => {
    const list = "What you need:\n• chicken thighs\n• garlic\n• lemon\n• thyme";
    expect(ingredientLikeLines(list)).toEqual(["chicken thighs", "garlic", "lemon", "thyme"]);
    // Two bullets are not a list.
    expect(ingredientLikeLines("• chicken\n• garlic")).toEqual([]);
  });

  it("needs at least two lines", () => {
    expect(MIN_INGREDIENT_LINES).toBe(2);
    expect(hasEnoughCaptionText("1 cup rice")).toBe(false);
    expect(hasEnoughCaptionText("1 cup rice\n2 cups water")).toBe(true);
  });
});

describe("importFromCaption", () => {
  it("returns a recipe with the post link as its source, without fetching", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const extract = model();
    const result = await importFromCaption(
      PASTA_CAPTION,
      { extract },
      {
        sourceUrl: "https://www.tiktok.com/@cooksimple/video/7000?utm_source=copy",
      },
    );
    expect(result).toMatchObject({ ok: true, path: "caption" });
    if (result.ok) {
      expect(result.recipe.title).toBe("Creamy Garlic Pasta");
      expect(result.recipe.sourceUrl).toBe("https://www.tiktok.com/@cooksimple/video/7000");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("asks the model with the caption source note", async () => {
    const extract = model();
    await importFromCaption(PASTA_CAPTION, { extract });
    const request = (extract as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    expect(request.user).toContain("caption of a social media post");
    expect(request.promptVersion).toBe("recipe-extract.v1");
    expect(request.kind).toBe("extract_recipe");
  });

  it("returns not_enough_text without calling the model or the network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const extract = model();
    const result = await importFromCaption(
      NO_RECIPE_CAPTION,
      { extract },
      {
        sourceUrl: "https://www.instagram.com/reel/abc/",
      },
    );
    expect(result).toMatchObject({ ok: false, reason: "not_enough_text" });
    expect(extract).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("returns not_enough_text when the model finds no recipe in a caption that looked like one", async () => {
    const extract: ModelExtract = async (schema) => ({
      value: schema.parse({
        found: false,
        title: "",
        description: null,
        servings: null,
        prep_minutes: null,
        cook_minutes: null,
        ingredients: [],
        steps: [],
        tags: [],
        cuisine: null,
      }),
      model: "claude-sonnet-5-5",
      attempts: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0,
    });
    const result = await importFromCaption("2 tickets\n3 friends\nbest night", { extract });
    expect(result).toMatchObject({ ok: false, reason: "not_enough_text" });
  });

  it("reports model_unavailable when the caption is good but there is no model", async () => {
    const result = await importFromCaption(PASTA_CAPTION, {});
    expect(result).toMatchObject({ ok: false, reason: "model_unavailable" });
  });
});

describe("splitSharedText", () => {
  it("separates the link from the words around it", () => {
    expect(
      splitSharedText("Check out this reel https://www.instagram.com/reel/abc/?igsh=1."),
    ).toEqual({
      text: "Check out this reel",
      url: "https://www.instagram.com/reel/abc/?igsh=1",
    });
    expect(splitSharedText("https://vm.tiktok.com/ZM123/")).toEqual({
      text: "",
      url: "https://vm.tiktok.com/ZM123/",
    });
  });

  it("keeps multi-line captions intact and handles no link", () => {
    const caption = "Pasta\n1 lb spaghetti\n2 cloves garlic";
    expect(splitSharedText(caption)).toEqual({ text: caption, url: null });
    expect(splitSharedText(`${caption}\nhttps://example.com/x`)).toEqual({
      text: caption,
      url: "https://example.com/x",
    });
  });
});
