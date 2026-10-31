# @mp/recipe-import

Turns a URL, pasted text, a photo, or a social caption into a `NormalizedRecipe` (`@mp/core`). Structured data first, model second. Ingredient lines stay as raw text; `@mp/ingredient-parser` (WS03) parses them later.

```ts
import { importFromUrl, importFromHtml, importFromText, importFromImage, importFromCaption } from "@mp/recipe-import";

const result = await importFromUrl("https://www.bbcgoodfood.com/recipes/focaccia", { extract });
if (result.ok) {
  result.recipe;   // NormalizedRecipe
  result.path;     // "jsonld" | "scraper" | "llm" | "text" | "vision" | "caption"
  result.warnings; // for example ["no_instructions"]
} else {
  result.reason;   // "blocked" | "video_platform" | "no_recipe_found" | "not_enough_text" | ...
}
```

`extract` is optional. It is `@mp/llm`'s `extract` bound to a client, a log sink, and a cost guard (the `recipe-import` Edge Function builds it). Without it, only the scrapers work and the model paths return `model_unavailable`.

## The paths

| Source | Method | Fallback |
|---|---|---|
| URL | Fetch with a desktop user agent in 10 s, then [`recipe-scrapers`](https://github.com/recipe-scrapers/recipe-scrapers) 3.x (JSON-LD, microdata, per-site rules) | Readable page text to Sonnet (`claude-sonnet-5-5`, prompt `recipe-extract.v1`) |
| Pasted text | Sonnet | None |
| Photo | Claude vision, same schema. The caller shows an editable draft | One retry on Opus when the reading is partial (under 2 ingredients, or no steps) |
| Caption | Sonnet, only after `ingredientLikeLines` finds at least 2 ingredient-like lines | `not_enough_text`, so the UI offers photo or paste |

`importFromHtml(html, url)` is the same URL pipeline on a page you already have. The golden-set eval and WS15 use it. It never touches the network.

### What the URL path does that recipe-scrapers alone does not

- **Required fields.** The library throws when a page has no description or no `http(s)` image, even with perfect ingredients and steps. A low-priority plugin supplies empty values (or the Open Graph image) so the import goes through.
- **HowToStep labels.** The library returns a step's `name` ("Sauce") and its `text` as two steps. A plugin reads `recipeInstructions` from the JSON-LD itself, keeps the text, and flattens `HowToSection` groups.
- **Repeated lines.** The library collects ingredients in a `Set`, so "1/2 teaspoon salt" listed for the batter and again for the filling comes back once. The page's own `recipeIngredient` list is used to put repeats back, because a shopping list should count them.
- **Bot checks.** A page that is a Cloudflare or Incapsula interstitial, or a 401, 403, 429, or 451, is `blocked`, and the model is not called on it.

### Telling whether the household already has a recipe

`src/dedupe.ts` is pure and has no imports, so the app reaches it through `@mp/recipe-import/dedupe` without the scrapers or the Anthropic SDK.

- `normalizeSourceUrl(link)`: trim, drop the fragment, lowercase the scheme and host, drop tracking parameters (`utm_*`, `fbclid`, `gclid`, `dclid`, `msclkid`, `mc_cid`, `mc_eid`, `igshid`, `igsh`, `ref_src`, `_ga`, `oly_*`: the list `cleanSourceUrl` strips) and empty ones, strip trailing slashes from the path. The path keeps its case and the rest of the query its order. The SQL twin is `public.normalize_source_url`, which fills `recipes.source_url_normalized`; `dedupe.fixtures.ts` is one list of links both are tested against.
- `normalizeTitle(title)` and `titleSearchPattern(title)`: case and spacing folded, and an `ilike` prefilter to find candidates. Used only when a recipe has no link.
- `dedupeIngredientLines(lines)`: the first of two lines with the same text (spacing folded, case kept) under the same heading stays. The same text under two headings stays, and so do lines that name one ingredient in different words ("1 tbsp butter", "2 tbsp butter, melted"). The `recipe-import` function applies it to what an importer returns, before a draft is returned or a recipe saved. It runs after "Repeated lines" above and overrides it for a line a page lists twice under one heading (or none): that line ends up once. A page whose sections repeat a line ("1/2 tsp salt" for the batter and the filling) keeps both when the sections are named, and loses one when they are not. The importers and the golden set are unchanged; only what the function stores differs.

### Rules the code enforces

- **No video platforms (R11).** `importFromUrl` refuses Instagram, TikTok, YouTube, Facebook, and Vimeo links before any request, including on a redirect hop. `importFromCaption` takes text and never fetches. Tests assert zero `fetch` calls (`src/url.test.ts`, `evals/import.eval.ts`).
- **No server-side request forgery.** Only `http` and `https` on ports 80 and 443, no credentials in the URL, no private, loopback, link-local, or internal host (IPv4, IPv6, and names like `localhost`, `*.local`, `*.internal`), redirects followed by hand with every hop checked, 4 MiB cap, 10 s total budget. The Edge Function also passes a DNS resolver (`resolveHost`) so a public name that resolves to a private address is refused. A DNS answer can still change between that check and the fetch; the function runs with no access to private networks, which is the control that matters.
- **Untrusted content stays out of the system prompt.** Page text, pasted text, and captions go inside `<source>` tags in the user message, and the system prompt says to treat them as data. The model returns JSON only and has no tools.
- **Every value is validated twice.** The model's schema (`RecipeExtractOutput`) and then `NormalizedRecipe` with the same limits as the database constraints. `@mp/llm` retries once on a schema failure.

## Evals

`evals/urls.json` is the golden set: 50 public pages across 25 domains, each with the expected title, ingredient count (plus or minus 1), and minimum step count. `expectPath` says which stage should read the page: `jsonld` (the page's own schema.org data) or `llm` (no structured data, so Sonnet reads the page text).

```bash
pnpm --filter @mp/recipe-import eval        # offline: recorded pages through importFromHtml, no network
pnpm --filter @mp/recipe-import eval:live   # re-fetch every URL, refresh the fixtures; with ANTHROPIC_API_KEY also re-run Sonnet and re-record its answers
deno run -A --config supabase/functions/recipe-import/deno.json packages/recipe-import/evals/record-deno.ts   # re-record the cases marked "recorder": "deno"
```

Output is one line per case and a summary (`evals/score.ts` has the format). A page that needs Sonnet and has no recorded answer shows as `PEND`, never `PASS`; the summary says how many passes are still possible, and the threshold becomes a hard check of the real pass count once every model case has a recording.

Two sites (allrecipes.com and seriouseats.com) answer Deno's `fetch` and refuse Node's with HTTP 403, so `eval:live`, which runs on Node, leaves them alone and `record-deno.ts` records them. The Supabase Edge runtime is Deno, so that script is also the closest local check of how production sees a site.

### Fixtures and licensing

The repository is public. Instruction prose, descriptions, and photos on recipe sites are copyrightable; ingredient lists, quantities, times, and yields are facts (docs/05 §Recipe content, docs/06 R5). So a fixture may hold only one of two things.

1. **Facts only, for a page with a JSON-LD Recipe.** `evals/redact.ts` reduces the page to its `<title>`, canonical link, and `og:title`, plus one JSON-LD Recipe with `name`, `recipeIngredient`, `recipeYield`, `prepTime`, `cookTime`, `totalTime`, and a placeholder author (a few site scrapers throw without one). Every `recipeInstructions` step becomes `Step 1.`, `Step 2.`, and so on, in the same count and the same sections. The body, descriptions, images, authors, keywords, nutrition, and scripts are dropped. A fixture is a few kilobytes.
2. **Real page text, only under an open license.** The model path needs readable text, so those fixtures keep the page (slimmed by `evals/slim.ts`). A case may do this only if `urls.json` gives it a `license` (name, URL, credit line). The six cases that do are Wikibooks Cookbook pages, CC BY-SA 4.0. `fixtures/index.json` records the license, its URL, and the attribution for each, and the pages are redistributed under the same license with that credit. A page with neither a JSON-LD Recipe nor a license cannot be recorded: `evals/record.ts` refuses it.

`evals/fixtures.test.ts` runs with `pnpm test` and in CI. It fails if a JSON-LD fixture is anything but the exact output of `redact.ts` (so no body text, description, image, or step prose can slip in), if a fixture is over 20 KB, if a model-path case has no license, or if the license and credit line are missing from the index.

How a fixture is made, so a refresh reproduces it:

- `evals/record.ts` (`recordCase`) fetches a page, redacts it or keeps it under its license, then imports both the full and the reduced page and fails unless they agree on path, title, ingredient count, and step count (step text differs by design). For a licensed page it also checks that the readable text the model would see is unchanged. `eval:live` and `record-deno.ts` both call it, so they write the same bytes.
- `evals/fixtures/<id>.html` is the fixture. `evals/fixtures/index.json` records the HTTP status, fetch time, size, `kind` (`redacted` or `licensed`), which runtime fetched it, and the license fields.
- `evals/fixtures/llm/<id>.json` is the recorded Sonnet answer for a page that needs one, with a hash of the exact prompt. A changed prompt or page text marks the recording stale (`PEND`) instead of replaying an old answer. The answer is a model's reading of openly licensed text.
- `evals/fixtures/biome.json` turns Biome off for the folder.

Expected values for the JSON-LD cases were read from each page's own JSON-LD, not from the importer. The six model cases were labelled by reading their page text. Imported recipes in the product are private to the household and keep their `source_url`.

## Scripts

```bash
pnpm --filter @mp/recipe-import typecheck
pnpm --filter @mp/recipe-import lint
pnpm --filter @mp/recipe-import test
```
