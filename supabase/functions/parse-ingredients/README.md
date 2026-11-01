# parse-ingredients

Turns free-text ingredient lines into structured rows with `@mp/ingredient-parser`. Called by the app (`packages/db`) with `{ recipeId }` after a recipe is imported, created or edited, and by the "Match ingredients" button.

Requires a signed-in user: send the user's JWT as `Authorization: Bearer <jwt>` (`verify_jwt` stays on).

## Requests

### `{ "lines": string[] }`

Parses the lines and returns them. Writes nothing except the parse cache, alias proposals, and `ai_runs`.

- 1 to 200 lines, each at most 500 characters.
- Response:

```json
{
  "ok": true,
  "results": [
    [{ "rawText": "2 cups diced yellow onion", "qty": 2, "unit": "cup", "ingredientId": "…",
       "ingredientName": "yellow onion", "prepNote": "diced", "optional": false,
       "confidence": 0.95, "stage": "grammar" }],
    [{ "rawText": "salt and pepper to taste", "ingredientName": "salt", "splitFrom": "salt and pepper to taste", "…": "…" },
     { "rawText": "salt and pepper to taste", "ingredientName": "black pepper", "splitFrom": "salt and pepper to taste", "…": "…" }]
  ],
  "meta": { "ingredients": 3, "lowConfidence": 0, "unresolved": 0, "modelCalls": 0, "modelAvailable": true }
}
```

`results[i]` belongs to `lines[i]`. A line that names several ingredients has several entries. Headers ("For the sauce:") and blank lines come back with `confidence: 0` and `ingredientName: null`; they never go to the model.

### `{ "recipeId": "<uuid>" }`

Parses every `recipe_ingredients` row of the recipe whose `parse_confidence` is null, and writes the result back as the caller (so row level security applies).

- The first ingredient of a line updates its row. Extra ingredients of a split line are inserted with the same `recipe_id`, `position`, `group_name`, and `raw_text`.
- Rows that already have a `parse_confidence` are skipped, so the call is safe to repeat.
- Response: `{ ok, recipeId, parsedRows, ingredients, lowConfidence, unresolved, modelCalls }`.

| Column | Value |
|---|---|
| `qty` | The amount. For a range, the lower bound. |
| `qty_max` | The upper bound of a range such as "2-3 cloves", else null. |
| `unit` | Canonical code from `@mp/core` `units.ts`. |
| `ingredient_id` | The ontology id, or null for an unknown name. |
| `prep_note` | "diced", "packed, divided", "to taste". |
| `optional` | True when the line says optional. |
| `parse_confidence` | 0 to 1. Lines under 0.8 are the ones to show for review. |

### Errors

| Status | `error` |
|---|---|
| 400 | `invalid_json`, `body_must_be_an_object`, `send_lines_or_recipeId`, `send_lines_or_recipeId_not_both`, `lines_must_be_strings`, `lines_must_not_be_empty`, `too_many_lines_max_200`, `line_too_long_max_500`, `recipeId_must_be_a_uuid` |
| 401 | `unauthorized` |
| 404 | `recipe_not_found` (also when the caller cannot see the recipe) |
| 405 | `method_not_allowed` |
| 500 | `internal_error`, `misconfigured` |

## What it reads and writes

| Table or function | Client | Why |
|---|---|---|
| `recipes`, `recipe_ingredients` | the caller (RLS) | load and save rows in `recipeId` mode |
| `ingredients`, `ingredient_aliases`, `match_ingredient_alias` | service role | ontology lookup |
| `ingredient_parse_cache` | service role | never parse a line twice |
| `record_ingredient_alias_proposal` | service role | names the ontology lacks |
| `ai_runs` | service role | one row per model call (the table is created by WS02's `ai_runs` migration) |

## Configuration

Supabase provides `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`. Set the model key as a secret:

```bash
supabase secrets set ANTHROPIC_API_KEY=… --project-ref <ref>
```

Without it the function still works: lines under 0.8 confidence keep their deterministic guess and `meta.modelAvailable` is false.

**Daily cap (WS15).** Each model call is checked first (`cost-guard.ts`, `createDailyCapGuard` from `@mp/llm`). A recipe's lines are capped with the household's cap (`households.ai_daily_cap_usd`, else `AI_DAILY_CAP_USD`, default 2 USD a day). The `lines` mode has no household, so the signed-in user is capped instead, by what they have spent on household-less calls today (`user_ai_spend_since`, `ai_runs.user_id`), at `AI_DAILY_CAP_USD`. Over the cap the lines still come back from the grammar and the ontology, the model is not called, and a failed `ai_runs` row with `error = 'cost_cap'` records the refusal. If the spend cannot be read, the model is not called either: the guard fails closed (`error = 'cost_unknown'`, reported to Sentry) and the lines come back the same way. Set `AI_DAILY_CAP_USD` as a secret like the model key.

## Develop and deploy

The container-based commands (`supabase functions serve`) need a container runtime. On the development Mac, deploy with the API bundler, which needs `SUPABASE_ACCESS_TOKEN`:

```bash
supabase functions deploy parse-ingredients --use-api
```

`deno.json` maps `@mp/core` and `@mp/llm` to their sources and pins `zod`, the Anthropic SDK, and supabase-js. The function imports the parser by relative path, so the bundler must be able to read `packages/`. That path has not been exercised by the Supabase bundler; see Open issues in the WS03 report. `deno check` and a `deno run` of the handler against the real parser both pass.

## Tests

```bash
pnpm exec vitest run --project unit supabase/functions/parse-ingredients
```

`index.test.ts` drives the handler with fakes. `store.test.ts` checks the Supabase calls against a small PostgREST fake. `client.ts` is the only file that imports supabase-js at runtime, so the tests mock it.
