import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";
import { findJsonLdRecipe } from "../src/html.ts";
import { importFromHtml } from "../src/index.ts";
import { redactRecipePage, sameImport } from "./redact.ts";

// Every sentence below is made up for this test. None is from a real site.
const PROSE = [
  "Zorblax pancakes are the fluffiest breakfast in the whole imaginary kingdom.",
  "Whisk the quillberries into the batter until the batter hums.",
  "Fold gently, then rest the bowl beside a sunny window for ten minutes.",
  "Fry until the edges look like lace, then serve with plum syrup.",
  "Rhubarb Rhonda",
  "https://cdn.example.test/photos/zorblax.jpg",
  "quillberry keywords, imaginary kingdom",
];

function page(recipe: Record<string, unknown>, extra = ""): string {
  return `<!doctype html><html><head>
<title>Zorblax pancakes recipe | Imaginary Kitchen</title>
<link rel="canonical" href="https://kitchen.example.test/zorblax-pancakes">
<meta property="og:title" content="Zorblax pancakes">
<meta property="og:description" content="${PROSE[0]}">
<meta name="description" content="${PROSE[0]}">
<meta property="og:image" content="${PROSE[5]}">
<script>window.tracker = "${PROSE[1]}";</script>
<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": [{ "@type": "WebSite", name: "Imaginary Kitchen" }, recipe] }).replace(/</g, "\\u003c")}</script>
</head><body><article><h1>Zorblax pancakes</h1><p>${PROSE[0]}</p>
<ul><li>2 cups quillberry flour</li></ul><p>${PROSE[3]}</p>${extra}</article></body></html>`;
}

const RECIPE = {
  "@type": "Recipe",
  name: "Zorblax pancakes",
  description: PROSE[0],
  image: [PROSE[5]],
  author: { "@type": "Person", name: PROSE[4] },
  keywords: PROSE[6],
  recipeYield: ["4", "4 servings"],
  prepTime: "PT10M",
  cookTime: "PT15M",
  totalTime: "PT25M",
  nutrition: { "@type": "NutritionInformation", calories: "300 calories" },
  recipeIngredient: ["2 cups quillberry flour", "1 1/2 cups plum milk", "2 sparkle eggs"],
  recipeInstructions: [
    { "@type": "HowToStep", name: "Mix", text: PROSE[1] },
    { "@type": "HowToStep", name: "Rest", text: PROSE[2] },
    { "@type": "HowToStep", name: "Fry", text: PROSE[3] },
  ],
};

describe("redactRecipePage", () => {
  const redacted = redactRecipePage(page(RECIPE)) ?? "";

  it("keeps the facts the importer and the scorer read", () => {
    const recipe = findJsonLdRecipe(cheerio.load(redacted));
    expect(recipe).toMatchObject({
      name: "Zorblax pancakes",
      recipeIngredient: ["2 cups quillberry flour", "1 1/2 cups plum milk", "2 sparkle eggs"],
      recipeYield: ["4", "4 servings"],
      prepTime: "PT10M",
      cookTime: "PT15M",
      totalTime: "PT25M",
    });
    expect(redacted).toContain("<title>Zorblax pancakes recipe | Imaginary Kitchen</title>");
    expect(redacted).toContain('href="https://kitchen.example.test/zorblax-pancakes"');
    expect(redacted).toContain('content="Zorblax pancakes"');
  });

  it("replaces every step with a numbered placeholder of the same count", () => {
    const recipe = findJsonLdRecipe(cheerio.load(redacted));
    expect(recipe?.recipeInstructions).toEqual([
      { "@type": "HowToStep", text: "Step 1." },
      { "@type": "HowToStep", text: "Step 2." },
      { "@type": "HowToStep", text: "Step 3." },
    ]);
  });

  it("drops descriptions, images, authors, keywords, nutrition, scripts, and the body", () => {
    for (const prose of PROSE) expect(redacted).not.toContain(prose);
    expect(redacted).not.toContain("calories");
    expect(redacted).not.toContain("quillberry flour</li>");
    expect(redacted).toContain("<body></body>");
    expect(redacted).not.toContain("og:description");
    expect(redacted).not.toContain("og:image");
    expect(redacted).not.toContain("tracker");
  });

  it("is deterministic and idempotent", () => {
    expect(redactRecipePage(page(RECIPE))).toBe(redacted);
    expect(redactRecipePage(redacted)).toBe(redacted);
  });

  it("keeps sections as sections with placeholder names and continuous numbering", () => {
    const sectioned = {
      ...RECIPE,
      recipeInstructions: [
        { "@type": "HowToStep", text: PROSE[1] },
        {
          "@type": "HowToSection",
          name: "The Zorblax sauce",
          itemListElement: [
            { "@type": "HowToStep", text: PROSE[2] },
            { "@type": "HowToStep", text: PROSE[3] },
          ],
        },
      ],
    };
    const out = redactRecipePage(page(sectioned)) ?? "";
    expect(out).not.toContain("Zorblax sauce");
    expect(findJsonLdRecipe(cheerio.load(out))?.recipeInstructions).toEqual([
      { "@type": "HowToStep", text: "Step 1." },
      {
        "@type": "HowToSection",
        name: "Section 1.",
        itemListElement: [
          { "@type": "HowToStep", text: "Step 2." },
          { "@type": "HowToStep", text: "Step 3." },
        ],
      },
    ]);
  });

  it("cannot be broken out of its script tag", () => {
    const hostile = { ...RECIPE, name: "</script><script>alert(1)</script>" };
    const out = redactRecipePage(page(hostile)) ?? "";
    expect(out.match(/<script/g)).toHaveLength(1);
    expect(findJsonLdRecipe(cheerio.load(out))?.name).toBe("</script><script>alert(1)</script>");
  });

  it("returns null for a page with no JSON-LD recipe", () => {
    expect(redactRecipePage("<html><body><p>Just a story.</p></body></html>")).toBeNull();
  });
});

describe("sameImport", () => {
  const url = "https://kitchen.example.test/zorblax-pancakes";

  it("holds for a redacted page: same path, title, ingredient count, and step count", async () => {
    const full = await importFromHtml(page(RECIPE), url, {});
    const reduced = await importFromHtml(redactRecipePage(page(RECIPE)) ?? "", url, {});
    expect(full).toMatchObject({ ok: true, path: "jsonld" });
    expect(sameImport(full, reduced)).toBe(true);
    if (reduced.ok) {
      expect(reduced.recipe.ingredients).toHaveLength(3);
      expect(reduced.recipe.instructions).toHaveLength(3);
    }
  });

  it("fails when a step goes missing", async () => {
    const full = await importFromHtml(page(RECIPE), url, {});
    const fewer = await importFromHtml(
      page({ ...RECIPE, recipeInstructions: RECIPE.recipeInstructions.slice(0, 2) }),
      url,
      {},
    );
    expect(sameImport(full, fewer)).toBe(false);
  });
});
