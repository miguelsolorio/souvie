import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";
import { hasJsonLdRecipe, looksLikeChallenge, pageImage, readableText } from "./html.ts";
import { packageName } from "./index.ts";

describe("@mp/recipe-import", () => {
  it("loads", () => {
    expect(packageName).toBe("@mp/recipe-import");
  });

  it("exports the five importers", async () => {
    const mod = await import("./index.ts");
    for (const name of [
      "importFromUrl",
      "importFromHtml",
      "importFromText",
      "importFromImage",
      "importFromCaption",
      "ingredientLikeLines",
      "isVideoPlatformUrl",
    ]) {
      expect(mod, name).toHaveProperty(name);
    }
  });

  it("resolves its workspace dependencies", async () => {
    await expect(import("@mp/core")).resolves.toBeDefined();
    await expect(import("@mp/llm")).resolves.toBeDefined();
  });
});

describe("hasJsonLdRecipe", () => {
  const withLd = (ld: string) =>
    cheerio.load(
      `<html><head><script type="application/ld+json">${ld}</script></head><body></body></html>`,
    );

  it("sees a Recipe at the top, in a graph, in a list, and as one of several types", () => {
    expect(hasJsonLdRecipe(withLd('{"@type":"Recipe"}'))).toBe(true);
    expect(hasJsonLdRecipe(withLd('{"@graph":[{"@type":"WebPage"},{"@type":"Recipe"}]}'))).toBe(
      true,
    );
    expect(hasJsonLdRecipe(withLd('[{"@type":"Thing"},{"@type":"Recipe"}]'))).toBe(true);
    expect(hasJsonLdRecipe(withLd('{"@type":["Thing","Recipe"]}'))).toBe(true);
  });

  it("does not see one in an article or in unrelated data", () => {
    expect(hasJsonLdRecipe(withLd('{"@type":"Article","name":"A Recipe for Success"}'))).toBe(
      false,
    );
    expect(hasJsonLdRecipe(cheerio.load("<p>none</p>"))).toBe(false);
  });

  it("notices a Recipe in malformed JSON", () => {
    expect(hasJsonLdRecipe(withLd('{"@type": "Recipe", oops'))).toBe(true);
  });
});

describe("readableText", () => {
  it("drops scripts, navigation, comments, and ads, and numbers nothing", () => {
    const $ =
      cheerio.load(`<html><head><title>Soup Recipe - Example</title><style>.a{}</style></head><body>
      <nav><a href="/">Home</a></nav>
      <article><h1>Soup</h1><p>${"Warm and good. ".repeat(20)}</p>
        <h2>Ingredients</h2><ul><li>1 onion</li><li>2 cups stock</li></ul>
        <h2>Steps</h2><ol><li>Simmer.</li></ol>
        <div class="comments-area"><p>Great recipe!!</p></div>
        <div class="newsletter-signup">Join our list</div>
      </article>
      <footer>Copyright</footer><script>alert(1)</script></body></html>`);
    const text = readableText($);
    expect(text).toContain("Page title: Soup Recipe - Example");
    expect(text).toContain("- 1 onion");
    expect(text).toContain("- 2 cups stock");
    expect(text).toContain("- Simmer.");
    for (const noise of ["Home", "Great recipe", "Join our list", "Copyright", "alert"]) {
      expect(text, noise).not.toContain(noise);
    }
  });

  it("prefers the recipe card when there is one", () => {
    const $ = cheerio.load(`<body><div>${"Blog story. ".repeat(60)}</div>
      <div class="wprm-recipe-container"><h2>Soup</h2><p>${"The method is easy. ".repeat(15)}</p><ul><li>1 onion</li></ul></div></body>`);
    const text = readableText($);
    expect(text).toContain("- 1 onion");
    expect(text).not.toContain("Blog story");
  });
});

describe("pageImage", () => {
  it("returns an absolute http(s) preview image", () => {
    expect(
      pageImage(
        cheerio.load('<meta property="og:image" content="/img/a.jpg">'),
        "https://example.com/r",
      ),
    ).toBe("https://example.com/img/a.jpg");
    expect(
      pageImage(
        cheerio.load('<meta name="twitter:image" content="https://cdn.example.com/b.png">'),
        "https://example.com/r",
      ),
    ).toBe("https://cdn.example.com/b.png");
    expect(
      pageImage(
        cheerio.load('<meta property="og:image" content="javascript:x">'),
        "https://example.com/r",
      ),
    ).toBeUndefined();
    expect(pageImage(cheerio.load("<p>none</p>"), "https://example.com/r")).toBeUndefined();
  });
});

describe("looksLikeChallenge", () => {
  it("recognizes bot-check pages and not real articles", () => {
    expect(looksLikeChallenge("<title>Just a moment...</title>")).toBe(true);
    expect(looksLikeChallenge("<title>Attention Required! | Cloudflare</title>")).toBe(true);
    expect(looksLikeChallenge("<h1>Access Denied</h1>")).toBe(true);
    expect(looksLikeChallenge(`<p>access denied</p>${"x".repeat(70_000)}`)).toBe(false);
    expect(looksLikeChallenge("<p>A lovely soup recipe</p>")).toBe(false);
  });
});
