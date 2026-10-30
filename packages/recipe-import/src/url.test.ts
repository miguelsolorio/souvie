import { LlmError } from "@mp/llm";
import { describe, expect, it, vi } from "vitest";
import type { ImportDeps, ModelExtract } from "./schema.ts";
import { isVideoPlatformUrl } from "./share.ts";
import {
  checkUrl,
  DESKTOP_USER_AGENT,
  fetchPage,
  importFromHtml,
  importFromUrl,
  isPrivateHost,
} from "./url.ts";

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

function recipeLd(over: Record<string, unknown> = {}) {
  return {
    "@context": "https://schema.org",
    "@type": "Recipe",
    name: "Lemon Chicken",
    description: "Bright and quick.",
    image: ["https://example.com/chicken.jpg"],
    author: { "@type": "Person", name: "A Cook" },
    recipeYield: ["4", "4 servings"],
    prepTime: "PT10M",
    cookTime: "PT35M",
    recipeIngredient: ["8 chicken thighs", "4 cloves garlic, smashed", "1 lemon, sliced"],
    recipeInstructions: [
      { "@type": "HowToStep", name: "Heat", text: "Heat the oven to 425F." },
      { "@type": "HowToStep", name: "Roast", text: "Roast 35 minutes." },
    ],
    recipeCategory: ["Dinner"],
    recipeCuisine: ["American"],
    keywords: "weeknight, chicken",
    ...over,
  };
}

function page(ld: unknown, extraHead = "", body = "<p>hello</p>") {
  const script = ld ? `<script type="application/ld+json">${JSON.stringify(ld)}</script>` : "";
  return `<!doctype html><html lang="en"><head><title>Lemon Chicken</title>${extraHead}${script}</head><body>${body}</body></html>`;
}

const LONG_BODY = `<article><h1>Easy Soup</h1><p>${"A comforting soup for cold evenings. ".repeat(8)}</p>
<h2>Ingredients</h2><ul><li>2 cups stock</li><li>1 onion</li><li>1 tsp salt</li></ul>
<h2>Method</h2><ol><li>Simmer everything.</li><li>Serve hot.</li></ol></article>`;

const MODEL_ANSWER = {
  found: true,
  title: "Easy Soup",
  description: null,
  servings: 4,
  prep_minutes: null,
  cook_minutes: 20,
  ingredients: [
    { text: "2 cups stock", group: null },
    { text: "1 onion", group: null },
    { text: "1 tsp salt", group: null },
  ],
  steps: ["Simmer everything.", "Serve hot."],
  tags: [],
  cuisine: null,
};

function fakeModel(answer: unknown = MODEL_ANSWER) {
  const calls: Array<Parameters<ModelExtract>[1]> = [];
  const extract: ModelExtract = async (schema, request) => {
    calls.push(request as never);
    return {
      value: schema.parse(answer),
      model: "claude-sonnet-5-5",
      attempts: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0,
    } as never;
  };
  return { extract, calls };
}

function failingModel(error: unknown): ModelExtract {
  return async () => {
    throw error;
  };
}

const html = (body: string, headers: Record<string, string> = {}, status = 200) =>
  new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });

// ---------------------------------------------------------------------------------------
// Address checks
// ---------------------------------------------------------------------------------------

describe("isVideoPlatformUrl", () => {
  it("matches video platforms and their subdomains", () => {
    for (const url of [
      "https://www.instagram.com/reel/abc/",
      "https://instagram.com/p/abc",
      "https://www.tiktok.com/@a/video/1",
      "https://vm.tiktok.com/ZM123/",
      "https://youtu.be/abc",
      "https://m.youtube.com/watch?v=abc",
      "https://www.youtube.com/shorts/abc",
      "https://fb.watch/abc/",
      "https://www.facebook.com/reel/1",
    ]) {
      expect(isVideoPlatformUrl(url), url).toBe(true);
    }
  });

  it("does not match lookalikes or recipe sites", () => {
    for (const url of [
      "https://www.seriouseats.com/x",
      "https://notyoutube.com/x",
      "https://youtube.com.evil.example/x",
      "https://example.com/?u=https://www.tiktok.com/x",
      "not a url",
    ]) {
      expect(isVideoPlatformUrl(url), url).toBe(false);
    }
  });
});

describe("isPrivateHost", () => {
  it("rejects private, loopback, link-local, and internal names", () => {
    for (const host of [
      "localhost",
      "app.localhost",
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "[::1]",
      "[fd00::1]",
      "[fe80::1]",
      "[::ffff:7f00:1]",
      "[2002:7f00:1::]",
      "intranet",
      "printer.local",
      "db.internal",
      "metadata.google.internal",
      "",
    ]) {
      expect(isPrivateHost(host), host).toBe(true);
    }
  });

  it("allows public hosts", () => {
    for (const host of [
      "example.com",
      "www.seriouseats.com",
      "8.8.8.8",
      "172.32.0.1",
      "[2606:4700::1111]",
    ]) {
      expect(isPrivateHost(host), host).toBe(false);
    }
  });
});

describe("checkUrl", () => {
  it("accepts an ordinary https URL", async () => {
    const checked = await checkUrl("https://example.com/recipe?id=1");
    expect(checked.ok).toBe(true);
  });

  it("rejects schemes, credentials, odd ports, video platforms, and private hosts", async () => {
    const cases: Array<[string, string]> = [
      ["ftp://example.com/x", "invalid_request"],
      ["javascript:alert(1)", "invalid_request"],
      ["https://user:pw@example.com/x", "invalid_request"],
      ["http://example.com:6379/", "invalid_request"],
      ["https://www.tiktok.com/@a/video/1", "video_platform"],
      ["http://localhost/x", "invalid_request"],
      ["http://2130706433/", "invalid_request"],
      ["http://0x7f.1/", "invalid_request"],
      ["http://[::1]/", "invalid_request"],
      ["not a url", "invalid_request"],
    ];
    for (const [url, reason] of cases) {
      const checked = await checkUrl(url);
      expect(checked.ok, url).toBe(false);
      if (!checked.ok) expect(checked.failure.reason, url).toBe(reason);
    }
  });

  it("uses the resolver to see through DNS", async () => {
    const toPrivate = await checkUrl("https://sneaky.example.com/x", async () => ["10.0.0.5"]);
    expect(toPrivate.ok).toBe(false);
    const toPublic = await checkUrl("https://fine.example.com/x", async () => ["93.184.216.34"]);
    expect(toPublic.ok).toBe(true);
    const unresolvable = await checkUrl("https://gone.example.com/x", async () => {
      throw new Error("NXDOMAIN");
    });
    expect(unresolvable.ok).toBe(false);
    if (!unresolvable.ok) expect(unresolvable.failure.reason).toBe("fetch_failed");
  });
});

// ---------------------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------------------

describe("fetchPage", () => {
  it("fetches with a desktop user agent, manual redirects, and no cookies", async () => {
    const fetchMock = vi.fn(async () => html("<p>ok</p>"));
    const result = await fetchPage("https://example.com/r", { fetch: fetchMock as never });
    expect(result).toEqual({ ok: true, html: "<p>ok</p>", finalUrl: "https://example.com/r" });
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.redirect).toBe("manual");
    expect((init.headers as Record<string, string>)["user-agent"]).toBe(DESKTOP_USER_AGENT);
    expect(DESKTOP_USER_AGENT).toMatch(/Macintosh.*Chrome\//);
    expect(init.headers).not.toHaveProperty("cookie");
    expect(init.credentials).toBeUndefined();
  });

  it("follows redirects, resolving relative locations, and reports the final URL", async () => {
    const responses = [
      new Response(null, { status: 301, headers: { location: "/moved" } }),
      html("<p>there</p>"),
    ];
    const fetchMock = vi.fn(async () => responses.shift() as Response);
    const result = await fetchPage("https://example.com/old", { fetch: fetchMock as never });
    expect(result).toMatchObject({ ok: true, finalUrl: "https://example.com/moved" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not follow a redirect into a private address", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } }),
    );
    const result = await fetchPage("https://example.com/r", { fetch: fetchMock as never });
    expect(result).toMatchObject({ ok: false, failure: { reason: "invalid_request" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not follow a redirect to a video platform", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://www.youtube.com/watch?v=x" },
        }),
    );
    const result = await fetchPage("https://short.example.com/abc", { fetch: fetchMock as never });
    expect(result).toMatchObject({ ok: false, failure: { reason: "video_platform" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after too many redirects", async () => {
    const fetchMock = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: "/loop" } }),
    );
    const result = await fetchPage("https://example.com/loop", { fetch: fetchMock as never });
    expect(result).toMatchObject({ ok: false, failure: { reason: "fetch_failed" } });
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(7);
  });

  it("maps refusals to blocked and other failures to fetch_failed", async () => {
    for (const status of [401, 403, 429, 451]) {
      const result = await fetchPage("https://example.com/r", {
        fetch: (async () => html("no", {}, status)) as never,
      });
      expect(result, String(status)).toMatchObject({
        ok: false,
        failure: { reason: "blocked", status },
      });
    }
    for (const status of [404, 410, 500, 503]) {
      const result = await fetchPage("https://example.com/r", {
        fetch: (async () => html("no", {}, status)) as never,
      });
      expect(result, String(status)).toMatchObject({
        ok: false,
        failure: { reason: "fetch_failed", status },
      });
    }
  });

  it("rejects a response that is not a web page", async () => {
    const result = await fetchPage("https://example.com/a.png", {
      fetch: (async () =>
        new Response("png", { headers: { "content-type": "image/png" } })) as never,
    });
    expect(result).toMatchObject({ ok: false, failure: { reason: "not_html" } });
  });

  it("enforces the size cap on a declared length and on a stream", async () => {
    const declared = await fetchPage("https://example.com/big", {
      maxBytes: 100,
      fetch: (async () => html("x", { "content-length": "5000" })) as never,
    });
    expect(declared).toMatchObject({ ok: false, failure: { reason: "too_large" } });

    const streamed = await fetchPage("https://example.com/big", {
      maxBytes: 100,
      fetch: (async () => html("y".repeat(500))) as never,
    });
    expect(streamed).toMatchObject({ ok: false, failure: { reason: "too_large" } });
  });

  it("times out", async () => {
    const hang = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      })) as never;
    const result = await fetchPage("https://example.com/slow", { timeoutMs: 20, fetch: hang });
    expect(result).toMatchObject({ ok: false, failure: { reason: "fetch_failed" } });
  });

  it("decodes the page with the declared charset", async () => {
    const bytes = new Uint8Array([0x63, 0x61, 0x66, 0xe9]); // "café" in ISO-8859-1
    const result = await fetchPage("https://example.com/latin", {
      fetch: (async () =>
        new Response(bytes, {
          headers: { "content-type": "text/html; charset=iso-8859-1" },
        })) as never,
    });
    expect(result).toMatchObject({ ok: true, html: "café" });
  });
});

// ---------------------------------------------------------------------------------------
// importFromHtml
// ---------------------------------------------------------------------------------------

describe("importFromHtml, structured data", () => {
  it("reads a JSON-LD recipe without a model", async () => {
    const result = await importFromHtml(
      page(recipeLd()),
      "https://example.com/lemon-chicken?utm_source=x",
    );
    expect(result).toMatchObject({ ok: true, path: "jsonld", warnings: [] });
    if (!result.ok) return;
    expect(result.recipe).toMatchObject({
      title: "Lemon Chicken",
      description: "Bright and quick.",
      sourceUrl: "https://example.com/lemon-chicken",
      servings: 4,
      prepMin: 10,
      cookMin: 35,
      cuisine: "american",
      ingredients: [
        { rawText: "8 chicken thighs" },
        { rawText: "4 cloves garlic, smashed" },
        { rawText: "1 lemon, sliced" },
      ],
    });
    expect(result.recipe.tags).toEqual(expect.arrayContaining(["dinner", "weeknight", "chicken"]));
  });

  it("uses a HowToStep's text, not its label, and drops section headings from the steps", async () => {
    const result = await importFromHtml(
      page(
        recipeLd({
          recipeInstructions: [
            {
              "@type": "HowToSection",
              name: "The sauce",
              itemListElement: [
                { "@type": "HowToStep", name: "Pulse", text: "Pulse in a blender." },
                { "@type": "HowToStep", name: "Warm", text: "Warm gently." },
              ],
            },
            { "@type": "HowToStep", name: "Serve", text: "Serve." },
          ],
        }),
      ),
      "https://example.com/r",
    );
    expect(result.ok && result.recipe.instructions).toEqual([
      "Serve.",
      "Pulse in a blender.",
      "Warm gently.",
    ]);
  });

  it("reads plain-string and newline-separated instructions", async () => {
    const result = await importFromHtml(
      page(recipeLd({ recipeInstructions: "Mix well.\nBake 20 minutes.\n\nCool." })),
      "https://example.com/r",
    );
    expect(result.ok && result.recipe.instructions).toEqual([
      "Mix well.",
      "Bake 20 minutes.",
      "Cool.",
    ]);
  });

  it("keeps a repeated ingredient line the library would drop", async () => {
    const result = await importFromHtml(
      page(
        recipeLd({ recipeIngredient: ["1/2 teaspoon salt", "2 cups flour", "1/2 teaspoon salt"] }),
      ),
      "https://example.com/r",
    );
    expect(result.ok && result.recipe.ingredients.map((i) => i.rawText)).toEqual([
      "1/2 teaspoon salt",
      "1/2 teaspoon salt",
      "2 cups flour",
    ]);
  });

  it("imports a recipe that has no description and a protocol-relative image", async () => {
    const result = await importFromHtml(
      page(recipeLd({ description: undefined, image: "//cdn.example.com/a.jpg" })),
      "https://example.com/r",
    );
    expect(result).toMatchObject({ ok: true, path: "jsonld" });
    if (result.ok) {
      expect(result.recipe).not.toHaveProperty("description");
      expect(result.recipe).not.toHaveProperty("imageUrl");
    }
  });

  it("takes the preview image from Open Graph when the data has none", async () => {
    const result = await importFromHtml(
      page(
        recipeLd({ image: undefined }),
        '<meta property="og:image" content="//cdn.example.com/og.jpg"><meta property="og:description" content="From the meta tag.">',
      ),
      "https://example.com/r",
    );
    expect(result.ok && result.recipe.imageUrl).toBe("https://cdn.example.com/og.jpg");
  });

  it("finds a recipe inside @graph", async () => {
    const result = await importFromHtml(
      page({
        "@context": "https://schema.org",
        "@graph": [{ "@type": "WebSite", name: "x" }, recipeLd()],
      }),
      "https://example.com/r",
    );
    expect(result).toMatchObject({ ok: true, path: "jsonld" });
  });

  it("survives malformed JSON-LD next to a good block", async () => {
    const broken = '<script type="application/ld+json">{ "@type": "Recipe", </script>';
    const result = await importFromHtml(page(recipeLd(), broken), "https://example.com/r");
    expect(result).toMatchObject({ ok: true, path: "jsonld" });
  });

  it("never calls the model when structured data is enough", async () => {
    const { extract, calls } = fakeModel();
    await importFromHtml(page(recipeLd()), "https://example.com/r", { extract });
    expect(calls).toHaveLength(0);
  });
});

describe("importFromHtml, model fallback", () => {
  it("sends the readable page text to Sonnet when there is no structured recipe", async () => {
    const { extract, calls } = fakeModel();
    const doc = page(
      null,
      '<meta property="og:image" content="https://example.com/soup.jpg">',
      LONG_BODY,
    );
    const result = await importFromHtml(doc, "https://example.com/soup?utm_campaign=x", {
      extract,
      householdId: "0a000000-0000-4000-8000-00000000000a",
    });

    expect(result).toMatchObject({ ok: true, path: "llm" });
    if (!result.ok) return;
    expect(result.recipe).toMatchObject({
      title: "Easy Soup",
      sourceUrl: "https://example.com/soup",
      imageUrl: "https://example.com/soup.jpg",
      servings: 4,
      cookMin: 20,
    });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call).toMatchObject({
      kind: "extract_recipe",
      promptVersion: "recipe-extract.v1",
      householdId: "0a000000-0000-4000-8000-00000000000a",
    });
    expect(call?.user).toContain("<source>");
    expect(call?.user).toContain("2 cups stock");
    expect(call?.user).toContain("It came from: https://example.com/soup");
    expect(call?.user).not.toContain("<script");
  });

  it("falls back when the data has no ingredients", async () => {
    const { extract, calls } = fakeModel();
    const doc = page(recipeLd({ recipeIngredient: [] }), "", LONG_BODY);
    const result = await importFromHtml(doc, "https://example.com/r", { extract });
    expect(result).toMatchObject({ ok: true, path: "llm" });
    expect(calls).toHaveLength(1);
  });

  it("reports model_unavailable when there is no model", async () => {
    const result = await importFromHtml(page(null, "", LONG_BODY), "https://example.com/r");
    expect(result).toMatchObject({ ok: false, reason: "model_unavailable" });
  });

  it("recognizes a bot-check page and does not pay for a model call", async () => {
    const { extract, calls } = fakeModel();
    const challenge =
      "<html><head><title>Just a moment...</title></head><body><p>Checking if the site connection is secure</p></body></html>";
    const result = await importFromHtml(challenge, "https://example.com/r", { extract });
    expect(result).toMatchObject({ ok: false, reason: "blocked" });
    expect(calls).toHaveLength(0);
  });

  it("reports no_recipe_found for a page with almost no text, without a model call", async () => {
    const { extract, calls } = fakeModel();
    const result = await importFromHtml(
      "<html><body><p>Hi</p></body></html>",
      "https://example.com/r",
      { extract },
    );
    expect(result).toMatchObject({ ok: false, reason: "no_recipe_found" });
    expect(calls).toHaveLength(0);
  });

  it("reports no_recipe_found when the model says there is none", async () => {
    const { extract } = fakeModel({
      ...MODEL_ANSWER,
      found: false,
      title: "",
      ingredients: [],
      steps: [],
    });
    const result = await importFromHtml(page(null, "", LONG_BODY), "https://example.com/r", {
      extract,
    });
    expect(result).toMatchObject({ ok: false, reason: "no_recipe_found" });
  });

  it("maps model errors to import failures", async () => {
    const doc = page(null, "", LONG_BODY);
    const cases: Array<[unknown, string]> = [
      [new LlmError("cost_cap", "over"), "cost_cap"],
      [new LlmError("not_configured", "no key"), "model_unavailable"],
      [new LlmError("api", "503"), "model_failed"],
      [new LlmError("invalid", "bad json"), "model_failed"],
      [new LlmError("refusal", "no"), "model_failed"],
      [new Error("boom"), "model_failed"],
    ];
    for (const [error, reason] of cases) {
      const deps: ImportDeps = { extract: failingModel(error) };
      const result = await importFromHtml(doc, "https://example.com/r", deps);
      expect(result, reason).toMatchObject({ ok: false, reason });
    }
  });

  it("keeps the model input within its limit, favoring the part around the ingredients", async () => {
    const story = "<p>".concat(
      "Once upon a time in a long and winding story. ".repeat(900),
      "</p>",
    );
    const doc = page(
      null,
      "",
      `<article>${story}<h2>Ingredients</h2><ul><li>3 eggs</li><li>1 cup milk</li></ul><p>Whisk and cook.</p></article>`,
    );
    const { extract, calls } = fakeModel();
    await importFromHtml(doc, "https://example.com/r", { extract });
    const sent = calls[0]?.user ?? "";
    expect(sent.length).toBeLessThan(26_000);
    expect(sent).toContain("3 eggs");
  });
});

// ---------------------------------------------------------------------------------------
// importFromUrl
// ---------------------------------------------------------------------------------------

describe("importFromUrl", () => {
  it("fetches and imports", async () => {
    const result = await importFromUrl("https://example.com/lemon-chicken", {
      fetch: (async () => html(page(recipeLd()))) as never,
    });
    expect(result).toMatchObject({ ok: true, path: "jsonld" });
  });

  it("uses the final URL after redirects as the attribution", async () => {
    const responses = [
      new Response(null, {
        status: 301,
        headers: { location: "https://www.example.com/lemon-chicken/" },
      }),
      html(page(recipeLd())),
    ];
    const result = await importFromUrl("https://example.com/lc", {
      fetch: (async () => responses.shift()) as never,
    });
    expect(result.ok && result.recipe.sourceUrl).toBe("https://www.example.com/lemon-chicken/");
  });

  it("returns blocked for a refusing site", async () => {
    const result = await importFromUrl("https://www.allrecipes.com/recipe/1/x", {
      fetch: (async () => html("Access Denied", {}, 403)) as never,
    });
    expect(result).toMatchObject({ ok: false, reason: "blocked", status: 403 });
  });

  it("makes no request for a video platform link", async () => {
    const fetchMock = vi.fn();
    for (const url of [
      "https://www.instagram.com/reel/abc/",
      "https://www.tiktok.com/@a/video/1",
      "https://youtu.be/abc",
    ]) {
      const result = await importFromUrl(url, { fetch: fetchMock as never });
      expect(result, url).toMatchObject({ ok: false, reason: "video_platform" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
