# WS02: Recipe domain & import

**Wave:** 2 · **Suggested model:** Sonnet · **Branch:** `ws/02-recipes-import`

## Goal
A household can get recipes into the app from a URL, pasted text, a photo, or by typing one in, and can view, edit, and delete them. URL import uses structured data first and a Claude Sonnet extraction fallback, and a checked-in golden set proves at least 45 of 50 real recipe pages import correctly. Recipes are the raw material for the planner (WS04) and the grocery list (WS05), so the ingredient lines must be stored as raw text ready for the parser (WS03).

## Depends on
- WS00: monorepo, `packages/recipe-import`, `packages/llm`, `supabase/functions`, Vitest `evals` project.
- WS01: auth, `households`, RLS helper `current_household_ids()`, migration convention, `@mp/db` client and hooks.

## Read first
1. `docs/02-data-model.md` §Recipes and §Ops (`import_jobs`)
2. `docs/03-ai-design.md` §4.1 (model tiers, structured outputs) and §4.4 (recipe import)
3. `docs/05-security-privacy.md` §Recipe content (copyright posture)
4. `docs/04-integrations.md` §Video import constraints (caption-only rule)
5. `docs/06-risks.md` R5, R11

## In scope
- Migration `<timestamp>_recipes.sql`: `recipes`, `recipe_ingredients`, `import_jobs` with RLS
- `packages/llm`: Anthropic client wrapper with structured output helper `extract<T>(schema, prompt, input)` using `claude-sonnet-5-5`, prompt registry with versions, `ai_runs` logging hook (table created here as `<timestamp>_ai_runs.sql` because this WS is the first caller)
- `packages/recipe-import`: `importFromUrl`, `importFromHtml(html, url)` (the fixture entry point used by evals and WS15), `importFromText`, `importFromImage`, `importFromCaption`, each returning a `NormalizedRecipe`
- URL path: fetch with a desktop user agent and 10 s timeout → `recipe-scrapers` TypeScript package (v3.x, Zod-validated) → normalize; on failure or missing ingredients, extract readable text and call Sonnet with the `NormalizedRecipe` schema
- Photo path: Claude vision with the same schema; user confirms before save
- Caption path: accepts share-sheet text or a pasted link's caption text only; never downloads media or transcripts; returns a typed "not enough text" result when the caption has no ingredients
- Edge Function `recipe-import`: accepts `{kind: 'url'|'text'|'image'|'caption', input}`, writes an `import_jobs` row, runs the import, writes the recipe, returns the recipe id
- Screens: recipe list, recipe detail (ingredients, steps, source attribution with link), add recipe (URL, paste, photo, manual tabs), edit recipe
- Golden set: `packages/recipe-import/evals/urls.json` with 50 public recipe URLs across at least 20 domains and expected `title`, ingredient count ±1, and step count ≥1; `packages/recipe-import/evals/import.eval.ts` runs them and reports pass count
- Storage bucket `recipe-images` with household-scoped write policy

## Out of scope
- Parsing ingredient lines into qty/unit/ingredient (WS03; store `raw_text` only here, leave `qty`, `unit`, `ingredient_id` null)
- Recipe embeddings and the `embedding` column population (WS06 fills it; create the column here)
- AI-generated recipes from a prompt (WS06)
- Shared public `catalog` recipes (v2); set `visibility = 'household'` always
- Video or audio download, transcript scraping, or Whisper (R11)
- Meal plan assignment (WS04)

## Deliverables
- `supabase/migrations/<timestamp>_recipes.sql`, `supabase/migrations/<timestamp>_ai_runs.sql`
- `supabase/tests/002_rls_recipes.sql`
- `supabase/functions/recipe-import/index.ts`
- `packages/llm/src/client.ts`, `packages/llm/src/extract.ts`, `packages/llm/src/prompts/registry.ts`, `packages/llm/src/prompts/recipe-extract.v1.ts`, `packages/llm/src/log.ts`
- `packages/recipe-import/src/index.ts`, `src/url.ts`, `src/text.ts`, `src/image.ts`, `src/caption.ts`, `src/normalize.ts`, `src/schema.ts`
- `packages/recipe-import/evals/urls.json`, `packages/recipe-import/evals/import.eval.ts`
- `packages/core/src/recipe.ts` (zod `NormalizedRecipe`, `Recipe`, `RecipeIngredient`)
- `apps/mobile/app/(app)/recipes/index.tsx`, `recipes/[id].tsx`, `recipes/[id]/edit.tsx`, `recipes/new.tsx`
- `apps/mobile/src/features/recipes/*` (hooks, forms, image picker, share-sheet receiver registration in `app.json`)
- `packages/db/src/hooks/useRecipes.ts`, `useRecipe.ts`, `useImportRecipe.ts`

## Interfaces
**Implements**
- `recipes(id, household_id null, title, description, image_url, source_type text check in ('url','text','photo','video','manual','ai'), source_url, servings int, prep_min int, cook_min int, instructions jsonb, nutrition jsonb, tags text[], cuisine text, embedding vector(1024) null, visibility text default 'household', created_by, created_at, updated_at, deleted_at)`
- `recipe_ingredients(id, recipe_id, position int, group_name text, raw_text text, qty numeric null, unit text null, ingredient_id uuid null, prep_note text, optional bool default false, parse_confidence real null)`
- `import_jobs(id, household_id, kind, input jsonb, status text check in ('queued','running','done','failed'), result_recipe_id, error text, created_at, finished_at)`
- `ai_runs(id, household_id, kind, model, input_tokens, output_tokens, cost_usd numeric, latency_ms, prompt_version, ok bool, created_at)`
- `NormalizedRecipe` zod schema in `@mp/core`: `{ title, description?, imageUrl?, sourceUrl?, servings?, prepMin?, cookMin?, ingredients: { rawText, groupName? }[], instructions: string[], nutrition?, tags?, cuisine? }`
- `@mp/llm`: `extract(schema, { system, user, images? , model? })`, `logAiRun(...)`
- Edge Function `recipe-import` request and response shapes documented in its README

**Consumes**
- `current_household_ids()`, `@mp/db` client and `useHousehold()` from WS01
- `ANTHROPIC_API_KEY` from WS00 env

Do not change `ProfilePreferences` or any WS01 table. Request changes in the report.

**Example `NormalizedRecipe`**
```json
{
  "title": "Weeknight Chicken Thighs with Lemon and Garlic",
  "sourceUrl": "https://example.com/recipes/lemon-garlic-chicken",
  "servings": 4,
  "prepMin": 10,
  "cookMin": 35,
  "ingredients": [
    { "rawText": "8 bone-in chicken thighs" },
    { "rawText": "4 cloves garlic, smashed" },
    { "rawText": "1 lemon, sliced", "groupName": "For the pan" }
  ],
  "instructions": ["Heat the oven to 425F.", "Season the thighs...", "Roast 35 minutes."],
  "tags": ["weeknight", "chicken"],
  "cuisine": "american"
}
```

**Eval output format** (one line per URL, then a summary)
```
seriouseats.com   path=jsonld    PASS  title ok, 11/11 ingredients, 6 steps
example-blog.com  path=llm       PASS  title ok, 9/10 ingredients, 4 steps
paywalled.com     path=blocked   FAIL  403
SUMMARY 46/50 pass  (jsonld 39, llm 7, blocked 3, failed 1)
```

## Acceptance criteria
1. `supabase db reset` applies `0003` and `0004`; `supabase test db` passes `002_rls_recipes.sql` proving a user cannot read another household's recipes or `import_jobs`.
2. `pnpm --filter @mp/recipe-import eval` runs the 50 golden cases from recorded HTML fixtures (offline, through `importFromHtml`) and reports ≥45 passing; `pnpm --filter @mp/recipe-import eval:live` re-fetches the URLs and refreshes the fixtures (title match, ingredient count within ±1, ≥1 instruction step). Output pasted in the report.
3. At least 5 of the 50 URLs lack JSON-LD and are imported via the Sonnet fallback; the eval output marks which path each used.
4. Importing a URL from the app creates an `import_jobs` row with `status = 'done'`, a `recipes` row with `source_type = 'url'` and `source_url` set, and `recipe_ingredients` rows with `raw_text` filled and `qty`, `unit`, `ingredient_id` null.
5. Pasting recipe text creates a recipe with `source_type = 'text'`.
6. Taking or choosing a photo of a recipe card produces an editable draft the user confirms; saved recipe has `source_type = 'photo'` and the image is in `recipe-images/<household_id>/...`.
7. Sharing an Instagram or TikTok post into the app on iOS opens the add screen with the caption text; if the caption has fewer than 2 ingredient-like lines, the UI shows the "not enough text in caption" state and offers photo or paste. No network request to the video platform is made (verified by the eval's mocked fetch or a proxy log).
8. Every Sonnet call writes one `ai_runs` row with model, token counts, and `prompt_version`.
9. Recipe detail shows the source domain as a link and never hides attribution for imported recipes.
10. Edit and delete work; delete sets `deleted_at` and the recipe disappears from lists.
11. `pnpm typecheck`, `pnpm lint`, `pnpm test` pass.

## Verification commands
```bash
supabase db reset && supabase test db                       # 0003, 0004 applied; RLS tests pass
pnpm eval --filter @mp/recipe-import                        # >= 45/50 pass, fallback path count shown
pnpm typecheck && pnpm lint && pnpm test                    # exit 0
supabase functions serve recipe-import                      # then:
curl -s -X POST localhost:54321/functions/v1/recipe-import -H "Authorization: Bearer $USER_JWT" -d '{"kind":"url","input":"https://www.seriouseats.com/..."}'
psql "$WORKER_DATABASE_URL" -c "select kind, model, ok from ai_runs order by created_at desc limit 5"
```

## Risks and notes
- From the WS03 re-review (2026-10-30), for whoever reworks the parser's model path into `@mp/llm`: `sanitizeItem` runs only inside `createAnthropicParseClient`, so `itemsFromLlm` trusts any replacement `LlmParseClient`; make the `@mp/llm` adapter sanitize or call `sanitizeItem` in `itemsFromLlm`. Negative cache entries (`{items: []}`) in `ingredient_parse_cache` never expire and ignore `prompt_version`; make the cache read skip entries whose `prompt_version` is older than the current prompt.
- From the WS03 report (2026-10-30): add `qty_max numeric` (nullable) to `recipe_ingredients`; `qty` is the lower bound of a range and `qty_max` the upper (docs/02). The orchestrator updates the `parse-ingredients` store mapping for `qtyMax` in the same contract commit. Create `ai_runs` exactly as docs/02 specifies; `parse-ingredients` already writes to it when the table exists. Move `packages/ingredient-parser/src/prompt.ts` into the `@mp/llm` prompt registry and replace its direct Anthropic client with `extract` once `@mp/llm` exists. Your `recipe_ingredients.ingredient_id` FK references `ingredients` from the WS03 migration, which sorts before yours.
- `recipe-scrapers` does not bypass bot protection. Some sites return 403 to non-browser user agents; the eval should mark these as "blocked" rather than "failed" and they still count against the 45.
- Store recipes private to the household and keep `source_url`. Instruction prose and images are copyrightable; the shared catalog (v2) will hold only licensed or original content (R5).
- Caption-only video import is a product rule, not a shortcut: YouTube captions require owning the video, Instagram oEmbed forbids persisting metadata, TikTok embed returns no description, and all three ToS forbid download (R11).
- Use `output_config` JSON-schema structured outputs with Sonnet; validate with zod anyway and retry once on schema failure.
- Keep `embedding vector(1024)` nullable; WS06 chooses the embedding model and backfills.
- Mitigates R5, R11; first user of `ai_runs` (R3).

**Suggested build order**
1. Migrations `0003`, `0004`; RLS tests for recipes and import_jobs.
2. `@mp/core` `NormalizedRecipe` schema; `@mp/llm` client, `extract`, prompt registry, `ai_runs` logging.
3. `importFromUrl` with the `recipe-scrapers` package; write 10 golden URLs and get them passing before adding the LLM fallback.
4. Sonnet fallback; grow the golden set to 50 across 20+ domains; tune until ≥45.
5. `importFromText`, `importFromImage`, `importFromCaption` with the "not enough text" state.
6. Edge Function `recipe-import`; wire `useImportRecipe`.
7. Screens: list, detail with attribution, add (four tabs), edit; share-sheet registration.
8. Completion report with the eval table.

## Completion report
End with the completion report from `docs/implementation-guide.md` §6.2 (Message templates). Include the eval summary table (URL, path used, pass/fail) under Verification output.

## Follow-up round (queued 2026-10-31): validation and duplicates on add

Requested by Miguel while testing against the hosted project: adding a recipe must validate what it is given, and adding the same recipe twice must not create a second copy. Today nothing on this path checks for duplicates: `recipes` has no uniqueness on `source_url` within a household, `recipe-import` never looks for an existing recipe, and `AddRecipe.tsx` only checks a minimum length and the video-platform rule. Dispatch after the WS04 follow-up round (picker entry points) merges, since both edit `AddRecipe.tsx`. Branch `ws/02b-add-validation`, Sonnet.

1. **Validate before submitting.** The link tab parses the URL with `HttpUrl` from `@mp/core` and shows an inline message for anything else ("That is not a web address"); the paste tab keeps its minimum and says why the button is disabled; the write tab requires a title and at least one ingredient line, servings a positive integer. Every function error already has a code; show its message, never a generic one.
2. **No duplicate recipes.** Before creating, `recipe-import` looks for a live recipe of the same household with the same normalized source URL (lowercase host, no fragment, no `utm_*`, `fbclid` or `gclid` parameters, no trailing slash) or, when there is no URL, the same normalized title (case and whitespace folded). If found, it answers `ok: false, error: "duplicate", recipeId` without creating anything, and the app shows "You already have this recipe" with "Open it" and "Add anyway" (which resends with `allowDuplicate: true`). The normalization is a pure function in `packages/recipe-import` with tests, shared by the function and the app.
3. **Deterministic backstop in SQL.** A migration (your table) adds `recipes.source_url_normalized text` filled by trigger from `source_url` with the same rules, and a partial unique index on `(household_id, source_url_normalized)` where `deleted_at is null` and the column is not null. Catalog rows (`household_id` null) are excluded. pgTAP: two inserts of the same link in one household fail the second, the same link in two households succeeds, a soft-deleted recipe frees its link, and the `policies_are` pins stay as they are.
4. **No duplicate ingredient lines.** Within one imported recipe, two lines with identical raw text after whitespace folding keep only the first; lines that resolve to the same ingredient with different raw text stay, since recipes repeat an ingredient across steps on purpose. Pure function with tests, applied in the import path before lines are written.
5. **Tests and report.** Function tests for the duplicate answer and `allowDuplicate`, app tests for the inline validation and the duplicate sheet, the pgTAP file, and the usual `pnpm typecheck && pnpm lint && pnpm test`. CI is the authority for the migration and pgTAP.

Deliverables for this round: `supabase/functions/recipe-import/` (handler, store, tests), a new migration and pgTAP file, `packages/recipe-import/src/` (normalization and line dedupe with tests), `apps/mobile/src/features/recipes/AddRecipe.tsx` and its tests, `packages/db/src/types.generated.ts` for the new column. Nothing under `packages/core` or other features.

