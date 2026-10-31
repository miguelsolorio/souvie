# recipe-import

Turns a URL, pasted text, a photo, or a share-sheet caption into a recipe in the caller's household. The importers are in `packages/recipe-import`; the model calls go through `packages/llm`. See `docs/03-ai-design.md` §4.

Requires a signed-in user who belongs to the household: send the user's JWT as `Authorization: Bearer <jwt>` (`verify_jwt` stays on).

## Request

`POST /functions/v1/recipe-import`, JSON. The shape is `ImportRecipeRequest` in `@mp/core` (`packages/core/src/recipe.ts`).

| Field | Meaning |
|---|---|
| `kind` | `url`, `text`, `image`, or `caption` |
| `input` | `url`: an http(s) address. `text`: 20 to 30,000 characters. `caption`: 1 to 10,000 characters. `image`: `{ "path": "<household_id>/<file>" }`, an object the app already uploaded to the `recipe-images` bucket |
| `sourceUrl` | `caption` only: the shared post's link. Stored as the recipe's `source_url` (attribution) and never fetched |
| `householdId` | Optional. Defaults to the caller's most recently joined household. The caller must be a member |
| `save` | Optional, default `true`. `false` returns the draft and writes no recipe, so the person can edit and confirm first. The app sends `false` for photos and captions |
| `allowDuplicate` | Optional, default `false`. Save even though the household has a recipe with the same title. It never overrides a same-link match (see Duplicates). Not in `ImportRecipeRequest` in `@mp/core` yet (contract change request in the WS02 follow-up report), so the handler reads it from the body |

```bash
curl -s -X POST "$SUPABASE_URL/functions/v1/recipe-import" \
  -H "Authorization: Bearer $USER_JWT" -H "Content-Type: application/json" \
  -d '{"kind":"url","input":"https://www.bbcgoodfood.com/recipes/focaccia"}'
```

## Response

HTTP 200 for every outcome of an import, including failures, so the app can read the body. HTTP errors are only for problems with the request itself.

Saved:

```json
{ "ok": true, "jobId": "…", "path": "jsonld", "recipeId": "…", "warnings": [] }
```

Draft (`save: false`):

```json
{ "ok": true, "jobId": "…", "path": "vision", "draft": { "title": "…", "ingredients": [{ "rawText": "…" }], "instructions": ["…"] }, "warnings": [] }
```

`path` says which stage read the recipe: `jsonld` and `scraper` (the page's own data), `llm` (Sonnet read the page text), `text`, `vision`, `caption`. `draft` is a `NormalizedRecipe`. For a photo, `draft.imageUrl` is the Storage path, so saving the draft keeps the photo.

Failed:

```json
{ "ok": false, "error": "blocked", "message": "…", "jobId": "…" }
```

| `error` | HTTP | Meaning |
|---|---|---|
| `unauthorized` | 401 | Missing or invalid token |
| `invalid_request` | 400 (413 if the body is over 200 KB) | Bad JSON, an unknown `kind`, a bad URL, a short text, or a photo path outside the household's folder |
| `no_household` | 400 | The caller has no household |
| `not_a_member` | 403 | `householdId` is not one of the caller's |
| `duplicate` | 200 | The household already has this recipe. The body also carries `recipeId` (the recipe that is there) and `matchedBy` (`url` or `title`). Nothing was created. See Duplicates |
| `video_platform` | 200 | An Instagram, TikTok, YouTube, Facebook, or Vimeo link. Nothing is fetched. Share the post into the app to import its caption |
| `blocked` | 200 | The site refused the request (401, 403, 429, 451) or showed a bot check |
| `fetch_failed`, `not_html`, `too_large` | 200 | The page could not be loaded, is not a web page, or is over 4 MiB (a photo over 5 MiB) |
| `no_recipe_found` | 200 | No recipe on the page, in the text, or in the photo |
| `not_enough_text` | 200 | A caption with fewer than 2 ingredient-like lines, or text under 20 characters. The model is not called |
| `model_unavailable` | 200 | The path needs a model and `ANTHROPIC_API_KEY` is not set |
| `model_failed` | 200 | The model refused, was cut off, or kept returning invalid JSON |
| `cost_cap` | 200 | The household reached its daily model budget |
| `rate_limited` | 200 | The household started 120 imports in the last hour |
| `image_not_found` | 200 | No such photo, or the caller cannot read it |
| `save_failed` | 500 | The recipe was read but could not be written; nothing is left half-saved |
| `internal_error` | 500 | Anything else. The body carries no internal detail |

The messages in `IMPORT_ERROR_MESSAGES` (`@mp/core`) are written for the person using the app.

## Duplicates

The function does not create a second copy of a recipe the household already has (live, not soft-deleted). It looks, as the caller, before it spends anything:

1. **The link, first.** For `url`, and for a `caption` that carries a `sourceUrl`, the link is cleaned and normalized (`normalizeSourceUrl` in `packages/recipe-import/src/dedupe.ts`: lowercase host, no fragment, no tracking parameters, no trailing slash) and looked up in `recipes.source_url_normalized`. A hit answers `duplicate` at once: no page fetch, no model call, no import job. This runs for drafts (`save: false`) too.
2. **The address the page ended at.** A short link that redirects is stored under the final address, so a `url` import checks that key again before saving. The import job is closed `failed` with `duplicate`.
3. **The title, when there is no link.** For pasted text, a photo, and a caption without a link, a recipe about to be saved is looked up by title with case and spacing folded. This is skipped for drafts (the app checks a draft when the person saves it) and when the request says `allowDuplicate: true`.

`matchedBy: "url"` cannot be overridden. A partial unique index (`recipes_household_source_url_normalized_uq`, migration `20261031130000`) allows one live recipe per link in a household, so a second copy would be refused by the database. If two saves of one link race past the lookup, the index refuses the second and the function answers `duplicate` for it too. `matchedBy: "title"` can be overridden: the app resends the same request with `allowDuplicate: true`.

If the lookup itself fails the import carries on (logged): a missed title match is a copy the person can delete, and the index still guards links.

Ingredient lines are stored as the importer returned them. A recipe may list the same line twice (the batter and the filling both take salt) and the grocery list counts both; see "Repeated lines" in `packages/recipe-import/README.md`.

## Matching the lines (parse-ingredients)

This function stores `raw_text` only. Turning lines into `ingredient_id`, `qty`, `unit` and the rest is `parse-ingredients`, and the app calls it with `{ recipeId }` after every write, as the signed-in person, awaited under a budget with failure non-fatal. The flow, and why it is the app and not this function, is in `packages/db/README.md` (Recipes, "Matching ingredient lines"). A recipe saved here is therefore unmatched for the moment between this response and that call, and stays so if the call fails; the recipe screen then offers "Match ingredients".

## What it writes

| Table | Client | What |
|---|---|---|
| `import_jobs` | service role | One row per call that passes the checks: `kind` (`url`, `text`, `photo`, `caption`), a small `input` (the URL without tracking parameters or fragment, which is the cleaning `recipes.source_url` gets; the photo path; or the length of pasted text, never the text), `status` running then `done` or `failed`, `result_recipe_id`, a short `error` |
| `recipes` | the caller (RLS) | `source_type` `url`, `text`, `photo`, or `video` (a caption with a post link; without one it is `text`), `source_url` for url and video, `visibility = 'household'`, `created_by` from the JWT. `source_url_normalized` is filled by a trigger; nothing here writes it. Also read (as the caller) for the duplicate lookup |
| `recipe_ingredients` | the caller (RLS) | One row per line with `position`, `group_name`, and `raw_text`. `qty`, `unit`, and `ingredient_id` stay null: WS03's `parse-ingredients` fills them (see above) |
| `ai_runs` | service role | One row per model call, `kind = extract_recipe`, `prompt_version = recipe-extract.v1`, tokens, cost, latency, ok |
| Storage `recipe-images` | the caller (RLS) | Read only, for `kind: "image"`. The app uploads the photo first |

If the ingredient lines fail to insert, the half-saved recipe is deleted (service role, scoped to the household) and the call returns `save_failed`.

## Limits and controls

- **Video platforms.** Never fetched. Captions arrive as text and are never turned into a request.
- **Fetching.** Desktop user agent, 10 s total, 4 MiB, ports 80 and 443 only, no private, loopback, or link-local address (including after a redirect and after DNS resolution), at most 5 redirects.
- **DNS rebinding is a known limitation.** The host name is resolved in a separate lookup (`Deno.resolveDns`) before each request, and the fetch then resolves it again on its own. An attacker's DNS server could answer differently the second time. The check cannot pin the connection to the address it looked at. The Supabase Edge runtime is expected to have no route to private networks, which would be the control that matters; nothing in this repo or CI verifies that yet (docs/09). When `Deno.resolveDns` is missing, the check is skipped: the function logs one warning when it starts and then rejects only IP literals and internal-looking names.
- **Daily model budget.** `AI_DAILY_CAP_USD` per household per UTC day (default 2). The function sums today's `ai_runs.cost_usd` before each model call and returns `cost_cap` at or over the limit. Imports that need no model are not counted.
- **Hourly import limit.** 120 `import_jobs` per household per hour.
- **Photos.** `input.path` must sit in the caller's household folder of the bucket; the download runs as the caller, so Storage policies apply as well.
- **Untrusted content.** Page text, pasted text, and captions go to the model as data, inside `<source>` tags. The model has no tools and returns JSON only.

## Configuration

Supabase provides `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`. Set the model key, and optionally the cap, as secrets:

```bash
supabase secrets set ANTHROPIC_API_KEY=… AI_DAILY_CAP_USD=2 --project-ref <ref>
```

Without `ANTHROPIC_API_KEY` the scraper path still works; the model paths answer `model_unavailable`.

## Develop and deploy

`supabase functions serve` needs a container runtime, which the development Mac does not have. Deploy with the API bundler, which needs `SUPABASE_ACCESS_TOKEN`:

```bash
supabase functions deploy recipe-import --use-api
```

`deno.json` maps `@mp/core`, `@mp/llm`, `cheerio`, `recipe-scrapers`, `zod`, the Anthropic SDK, and supabase-js. The function imports `packages/core`, `packages/llm`, and `packages/recipe-import` by relative path, so the bundler must be able to read `packages/` (the same path `parse-ingredients` relies on; it has not been exercised by the Supabase bundler here). `deno check` on `index.ts` and a `deno run` of the importer against the recorded pages both pass with this import map.

## Tests

```bash
pnpm exec vitest run --project unit supabase/functions/recipe-import
```

`index.test.ts` drives the handler with a fake store and model: authentication, membership, every kind, drafts, job rows, error mapping, the photo path rule, zero requests for video links, the duplicate answer (link, redirected link, title, `allowDuplicate`, a lost race, a failed lookup), and repeated ingredient lines. `store.test.ts` checks the Supabase calls against a small PostgREST fake. `migration.test.ts` runs the `recipes_source_url_normalized` migration on PGlite (no container): the backfill over a household that already holds a link twice, the SQL function against `normalizeSourceUrl` on one shared list of links, and `supabase/tests/ws02b_recipes_dedupe.sql` through the pgTAP shim. `client.ts` is the only file that imports supabase-js at runtime, so the tests mock it.
