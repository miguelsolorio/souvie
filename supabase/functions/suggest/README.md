# suggest

Plans a household's dinners for a week, picks the twelve recipes on the onboarding swipe screen, and fills in recipe embeddings. Retrieve, filter, compose, learn (`docs/03-ai-design.md` §3). Built in WS06.

Requires a signed-in user who belongs to the household: send the user's JWT as `Authorization: Bearer <jwt>` (`verify_jwt` stays on).

## Request

`POST /functions/v1/suggest`, JSON. The shape is `SuggestRequest` in `@mp/core` (`packages/core/src/preferences.ts`).

| Field | Meaning |
|---|---|
| `householdId` | The household to act in. The caller must be a member |
| `weekStart` | A Monday, `YYYY-MM-DD`. Any other day is `week_not_monday` |
| `mode` | `draft`, `replace`, `calibration`, or `backfill` |
| `dinners` | Optional, 1 to 7. Defaults to the caller's `dinners_per_week`, else 5 |
| `date` | `replace`: optional, replace just that night. `swap`: required, the night to suggest for |
| `slot` | `swap` only, required: `breakfast`, `lunch`, `dinner`, or `snack` |
| `excludeRecipeIds` | `swap` only, optional, up to 200 recipe ids the suggestion must not return |

| Mode | What it does |
|---|---|
| `draft` | Composes the week. If the week already has dinners it returns them unchanged (`composedBy: "existing"`) and calls no model |
| `replace` | Composes again. Without `date`, every still-planned dinner of the week is replaced and cooked or skipped ones stay. With `date`, only that night, and never with the recipe it had |
| `swap` | One recipe for one slot, for the planner's "swap with a suggestion" (WS04). Same filters and ranking as `draft`, minus recipes in `excludeRecipeIds` and the ones already on that week's plan. Writes nothing: no plan, no entry, no feedback, no embedding refresh, no model call. The reason is built from facts, not by a model. Another slot than `dinner` also lets recipes tagged breakfast, dessert, and the like through. Returns `{ ok, planId?, entries }` with exactly one entry, `planId` only when the week already has a plan |
| `calibration` | Twelve recipes for the swipe screen, spread over cuisines, leaving out ones the caller already answered (a like or a dislike). Writes nothing |
| `backfill` | Embeds up to 50 of the household's recipes that have no embedding. Needs `VOYAGE_API_KEY` |

```bash
curl -s -X POST "$SUPABASE_URL/functions/v1/suggest" \
  -H "Authorization: Bearer $USER_JWT" -H "Content-Type: application/json" \
  -d '{"householdId":"<uuid>","weekStart":"2026-11-02","mode":"draft"}' | jq '.entries | length'
```

## Response

HTTP 200 for every outcome of a plan, including the ones that need the person's attention, so the app can read the body. HTTP errors are only for problems with the request.

```json
{ "ok": true, "planId": "…", "composedBy": "model",
  "entries": [{ "date": "2026-11-02", "slot": "dinner", "recipeId": "…", "servings": 4, "why": "Quick on a school night." }],
  "notes": "Cilantro carries over.", "shortBy": 0 }
```

`composedBy` is `model` (Sonnet composed it), `fallback` (ranked candidates, see below), or `existing`. `shortBy` appears when fewer recipes fit than dinners were asked for. Calibration returns `{ ok, recipeIds, cards }`; each card has the recipe's own title, description, image URL (a short-lived signed URL for a stored photo), cuisine, minutes, tags, and `sourceUrl` for the attribution line. Backfill returns `{ ok, embedded, remaining }`.

Failed: `{ "ok": false, "error": "…", "message": "…" }`.

| `error` | HTTP | Meaning |
|---|---|---|
| `unauthorized` | 401 | Missing or invalid token |
| `invalid_request`, `week_not_monday` | 400 (413 if over 4 KB) | Bad JSON or body, a date outside the week, a night already cooked, or no night left to fill |
| `not_a_member` | 403 | `householdId` is not one of the caller's |
| `allergies_not_set` | 200 | The caller never answered the allergy question (`preferences.allergies` is absent; an empty list is an answer) |
| `no_candidates` | 200 | No recipe passes the filters. Calibration returns an empty list instead |
| `embedding_unavailable` | 200 | `backfill` without `VOYAGE_API_KEY` |
| `internal_error` | 500 | Anything else. The body carries no internal detail |

## How a plan is made

1. **Membership.** The caller must belong to the household. The household id used by every later query comes from that check.
2. **Allergy gate.** The caller's `preferences.allergies` must exist.
3. **Embeddings** (only with `VOYAGE_API_KEY`). Up to 40 of the household's recipes with no vector are embedded, then the caller's taste vector is rebuilt: Haiku writes a short taste description from preferences, likes, and skips (plain text without an Anthropic key), it is embedded as a query, and half the final vector is the average of the liked recipes' vectors. Any failure here only costs ranking quality.
4. **Candidates** (`filters.ts`, `candidates.ts`). One SQL query over the household's recipes and the catalog applies every hard filter, then the pool is ranked and the top 60 kept. The ingredient lines of those 60 are read back and checked again in TypeScript; a recipe that fails is dropped and logged. The model only sees what both checks passed.
5. **Compose** (`compose.ts`). Sonnet gets the numbered candidates and the dates and answers with positions. Code rejects an out-of-range index, a repeated recipe or date, an unoffered date, or the wrong number of dinners; the call is retried once with the problem described, then `ComposeError`. Recipe ids come from the candidate list, never from the model.
6. **Fallback.** No Anthropic key, a spent budget, or two bad answers: the best-ranked candidates, spread over cuisines, quickest first. The reason on each is built from facts (minutes, favorite cuisine), not from a model.
7. **Write.** One transaction takes an advisory lock on the household and week, makes the `meal_plans` row if needed, removes the dinners being replaced, and inserts the new ones with `status = 'planned'` and the reason in `notes`. Two drafts at once write one plan.

### The hard filters

Filters are SQL `where` clauses built by `buildFilterSpec` and `buildCandidateQuery` from the household's rules. Everyone's allergies and diets apply to a shared plan; the caller's never-foods and weeknight minutes apply because they belong to one person.

- **Allergies** (the nine in `ALLERGENS`). The brief assumed an `ingredients.allergen_tags` column. The ontology WS03 shipped has none, so each allergen has a term list (`ALLERGEN_PATTERNS` in `filters.ts`) matched against the parsed ingredient name and the line's raw text, plus category rules where the category is a clean signal (eggs, dairy, and seafood that is not shellfish). Raw text matters: a recipe whose lines the parser has not resolved yet would otherwise pass. The lists err toward excluding. They can still miss a food they do not name; a tag column on the ontology is the fix (see the WS06 report).
- **Diets.** vegetarian, vegan, pescatarian, halal, kosher, gluten free, and dairy free are enforced from ingredient terms, categories, and a few recipe tags. low carb, keto, and paleo cannot be proven from an ingredient list, so they steer the composer only. Kosher does not check meat and dairy mixing.
- **Never-foods.** Resolved to ingredients through `ingredients.name`, `plural`, and `ingredient_aliases`, and matched as whole words in raw text. Nothing derived is stored.
- **Time.** `prep_min + cook_min` at most `weeknight_minutes`. A recipe with no time passes. The limit applies to every night; weekends are not relaxed.
- **Not dinners.** Recipes tagged dessert, drinks, breakfast, snack, and similar are left out.
- **Scope.** Deleted recipes and other households' recipes are never returned. Catalog recipes (`visibility = 'catalog'`) are visible to every household.
- **Unknown values fail closed.** An allergen or diet with no rule throws, and the profile CHECK constraint refuses to store one.

### Ranking

`score = similarity + 0.12 (favorite cuisine) + 0.08 per like (up to 2) - 0.05 per skipped night (up to 2) - 0.3 for a thumbs down (once) + 0.08 × popularity (likes across households, saturating at 50) - 0.25 (cooked in the last 14 days) or - 0.10 (last 28) + 0.05 (household's own recipe)`. Similarity is cosine similarity to the taste vector, or 0 on a cold profile, which is then ranked by cuisine, popularity, and the household bonus. Ties break on title, then id.

## What it reads and writes

The function connects to Postgres as the database owner (`SUPABASE_DB_URL`), which bypasses RLS, so every statement names the household explicitly (`store.ts`).

| Table | Access | Columns used |
|---|---|---|
| `household_members`, `households` | read | membership, `deleted_at` |
| `profiles` | read; writes `taste_embedding` | `preferences`, `onboarding_step`, `taste_embedding` |
| `recipes`, `recipe_ingredients`, `ingredients`, `ingredient_aliases` | read; writes `recipes.embedding` | see `filters.ts` |
| `meal_plans`, `meal_plan_entries` (WS04) | read, insert, delete planned dinners | `meal_plans(household_id, week_start)`; entries `(plan_id, household_id, date, slot, recipe_id, servings, status, why, position)` |
| `recipe_feedback` (WS04) | read | `(household_id, user_id, recipe_id, signal, created_at)`; if the table is missing, ranking runs without history |
| `ai_runs` | insert, read | every model and embedding call; the daily spend |

The one-line reason is stored in `meal_plan_entries.why` (WS04's migration adds the column) and `notes` is left to the person. Servings are rounded to whole numbers for `meal_plan_entries.servings`.

## `ai_runs`

Every model or embedding call writes a row, failures and retries included: `suggest.compose` (Sonnet, `suggest-compose.v1`), `suggest.embed` (Voyage `voyage-3`, and the Haiku taste summary, `suggest-taste-summary.v1`). When no call can be made (no Anthropic key, or the household is over its daily budget) the plan writes one `suggest.compose` row with `ok = false` and the reason, so every plan leaves a record. Calibration and `existing` drafts make no model call and write no row.

## Limits and controls

- **Daily budget.** `AI_DAILY_CAP_USD` per household per UTC day (default 2) covers model and embedding spend. Over it, planning falls back to ranking.
- **Untrusted text.** Recipe titles, tags, and the person's note reach the model inside tagged blocks as data, with angle brackets removed. The model has no tools and returns JSON only.
- **Images.** Only paths inside the caller's household folder of `recipe-images` are signed.

## Configuration

Supabase provides `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_DB_URL`. Optional secrets:

```bash
supabase secrets set ANTHROPIC_API_KEY=… VOYAGE_API_KEY=… AI_DAILY_CAP_USD=2 --project-ref <ref>
```

Without `ANTHROPIC_API_KEY` plans use the ranked fallback. Without `VOYAGE_API_KEY` nothing is embedded and ranking uses cuisine and popularity.

## Develop and deploy

`supabase functions serve` needs a container runtime, which the development Mac does not have. Deploy with the API bundler:

```bash
supabase functions deploy suggest --use-api
```

`deno.json` maps `@mp/core`, `@mp/llm`, `postgres`, `zod`, the Anthropic SDK, and supabase-js. CI type-checks `index.ts` with it. Postgres.js was driven through this code against PGlite over the wire protocol while building it (see the WS06 report); it has not run against a hosted project.

## Tests

```bash
pnpm exec vitest run --project unit supabase/functions/suggest
pnpm eval suggest
```

The tests run the real SQL on PGlite (Postgres 18 compiled to WASM, with pgvector and pg_trgm) after applying the repo's migrations to it, through `testing/db.ts`. That is a stand-in for Postgres 17 on Supabase, not the thing itself. WS04's planning migration and the catalog read policies load from `supabase/migrations/` like the rest, so the tests exercise the real `meal_plan_entries` (with its `why` cap and triggers) and `recipe_feedback` (with its grants and policy). `calibration-feedback.test.ts` runs the onboarding deck's feedback rows against that policy as the `authenticated` role. `filters.test.ts` checks the builder and both filter engines against each other; `compose.test.ts` drives the real `extract` with a fake model; `handler.test.ts` runs the whole function; `candidates.test.ts` and `profile-embedding.test.ts` cover ranking and vectors.
