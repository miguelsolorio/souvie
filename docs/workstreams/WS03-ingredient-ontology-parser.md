# WS03: Ingredient ontology & parser

**Wave:** 1 · **Suggested model:** Sonnet · **Branch:** `ws/03-ingredient-ontology-parser`

## Goal
Turn free-text ingredient lines like "2 cups diced yellow onion" into structured `{ qty, unit, ingredient, prepNote }` against a canonical ingredient ontology, with a unit-conversion module that can move between volume, weight, and count. A checked-in 500-line golden set proves accuracy. Without this, the grocery list (WS05) cannot aggregate across recipes and the shopping agent (WS09) cannot search a catalog.

## Depends on
- WS00: monorepo, `packages/ingredient-parser`, `packages/core`, `packages/llm` shell, `supabase/seed`, Vitest `evals` project, `pg_trgm` extension enabled.
- Runs in parallel with WS01 and does not need auth: the `ingredients` and `ingredient_aliases` tables are global reference data with read-for-all policies.

## Read first
1. `docs/03-ai-design.md` §4.5 (ingredient parsing) and §4.6 (list aggregation, for what the unit module must support)
2. `docs/02-data-model.md` §Recipes (`ingredients`, `ingredient_aliases`, `recipe_ingredients` columns the parser fills)
3. `docs/03-ai-design.md` §4.1 (Haiku for parsing, structured outputs, cost logging)
4. `docs/06-risks.md` R2, R3

## In scope
- Migration `<timestamp>_ingredients.sql`: `ingredients`, `ingredient_aliases` (global, no `household_id`; `select` for authenticated users, writes via service role only), trigram index on `ingredient_aliases.alias`
- Seed `supabase/seed/ingredients.csv` with about 600 rows and `supabase/seed/ingredient_aliases.csv`; loader script `supabase/seed/load.ts` run by `supabase db reset` hook or `pnpm seed`
- `packages/core/src/units.ts`: unit dictionary with aliases (cup, c, tbsp, tablespoon, tsp, oz, fl oz, lb, g, kg, ml, l, pinch, clove, head, bunch, can, package, slice, large, medium, small, each), `convert(qty, fromUnit, toUnit, ingredient)` using `density_g_per_ml` and `typical_unit_weight_g`, and `toPurchasable(qty, unit, ingredient)`
- `packages/ingredient-parser`: `parseLine(rawText)` grammar stage (quantities as integers, decimals, unicode and ASCII fractions, ranges "1-2", "1 to 2"; units; prep phrases after a comma or in parentheses; "to taste", "optional", "divided"), ontology lookup stage (exact alias, then trigram similarity ≥ 0.6), confidence score, Haiku fallback stage for lines below 0.8 confidence in batches of 25 with a strict schema, and a cache table keyed by normalized `raw_text`
- Edge Function `parse-ingredients`: accepts `{ recipeId }` or `{ lines: string[] }`, fills `recipe_ingredients.qty/unit/ingredient_id/prep_note/optional/parse_confidence`
- Unknown ingredients: write to `ingredient_alias_proposals(alias, suggested_ingredient_id, source, count)` for later review
- Golden set `packages/ingredient-parser/evals/lines.json` with 500 labeled lines and `parse.eval.ts`

## Out of scope
- Creating `recipes` or `recipe_ingredients` tables (WS02 does; this WS only writes into columns WS02 defined)
- Product matching to retailer SKUs (WS07, WS09)
- Nutrition lookup via USDA (optional later; only store `usda_fdc_id` if present in the seed)
- Aggregating lines across recipes (WS05 calls `units.ts`; this WS provides the module)
- A review UI for alias proposals (later)

## Deliverables
- `supabase/migrations/<timestamp>_ingredients.sql` (also creates `ingredient_parse_cache(raw_text_norm text pk, result jsonb, model text, created_at)` and `ingredient_alias_proposals`)
- `supabase/seed/ingredients.csv`, `supabase/seed/ingredient_aliases.csv`, `supabase/seed/load.ts`, `supabase/seed/README.md` (column meanings and how to add rows)
- `supabase/tests/003_ingredients_policies.sql`
- `supabase/functions/parse-ingredients/index.ts`
- `packages/core/src/units.ts`, `packages/core/src/units.test.ts`, `packages/core/src/ingredient.ts` (zod `Ingredient`, `ParsedIngredient`)
- `packages/ingredient-parser/src/index.ts`, `src/grammar.ts`, `src/lookup.ts`, `src/llm-fallback.ts`, `src/cache.ts`, `src/normalize.ts`
- `packages/ingredient-parser/evals/lines.json`, `packages/ingredient-parser/evals/parse.eval.ts`
- `packages/llm/src/prompts/ingredient-parse.v1.ts` (coordinate with WS02, which creates the registry; if WS02 has not merged, put the prompt in `packages/ingredient-parser/src/prompt.ts` and note it in the report)

## Interfaces
**Implements**
- `ingredients(id uuid pk, name text unique, plural text, category text, default_unit text, density_g_per_ml numeric null, typical_unit_weight_g numeric null, usda_fdc_id text null, is_staple_default bool default false)`; `category` values are the store sections: `produce, meat, seafood, dairy, eggs, bakery, pantry, spices, canned, frozen, beverages, snacks, baking, international, household, other`
- `ingredient_aliases(id, ingredient_id, alias text, source text check in ('seed','llm','user'))`, unique on `(alias)`
- `ParsedIngredient` zod: `{ rawText, qty: number|null, qtyMax?: number|null, unit: string|null, ingredientId: string|null, ingredientName: string|null, prepNote?: string, optional: boolean, confidence: number, stage: 'grammar'|'lookup'|'llm' }`
- `parseLine(rawText, deps): Promise<ParsedIngredient>` and `parseLines(rawTexts[], deps)` in `@mp/ingredient-parser`
- `convert`, `toPurchasable`, `normalizeUnit`, `UNIT_ALIASES` in `@mp/core` (`units.ts`)
- Edge Function `parse-ingredients` request shapes documented in its README

**Consumes**
- `recipe_ingredients` columns from WS02 (`qty`, `unit`, `ingredient_id`, `prep_note`, `optional`, `parse_confidence`); if WS02 is not merged yet, test against a local fixture table and note it
- `@mp/llm` `extract` if merged; otherwise a minimal Anthropic call inside `llm-fallback.ts` behind the same function signature, to be swapped later (state this in the report)

Shared contracts belong to the orchestrator. If `ParsedIngredient` needs fields WS05 or WS09 will want, propose them in the report rather than adding them silently.

**Example parses**
```json
[
  { "rawText": "2 cups diced yellow onion", "qty": 2, "unit": "cup", "ingredientName": "yellow onion",
    "prepNote": "diced", "optional": false, "confidence": 0.97, "stage": "grammar" },
  { "rawText": "1 (14 oz) can diced tomatoes", "qty": 14, "unit": "oz", "ingredientName": "diced tomatoes",
    "prepNote": null, "optional": false, "confidence": 0.9, "stage": "lookup" },
  { "rawText": "salt and pepper to taste", "qty": null, "unit": null, "ingredientName": "salt",
    "prepNote": "to taste", "optional": false, "confidence": 0.85, "stage": "llm" }
]
```
A line naming two ingredients ("salt and pepper") returns one `ParsedIngredient` per ingredient from `parseLines`; `parseLine` returns the first and sets `splitFrom` on both. Document this in the package README.

**Seed CSV header**
```
name,plural,category,default_unit,density_g_per_ml,typical_unit_weight_g,usda_fdc_id,is_staple_default
yellow onion,yellow onions,produce,each,,150,,false
all-purpose flour,,baking,cup,0.53,,,true
kosher salt,,spices,tsp,1.2,,,true
```

## Acceptance criteria
1. `supabase db reset` applies `0005` and loads ≥ 600 `ingredients` and ≥ 1,200 `ingredient_aliases` rows (counts in report).
2. Every seed row has `category` from the fixed list and `default_unit` set; at least 150 rows have `density_g_per_ml` and at least 100 have `typical_unit_weight_g` (a test asserts these counts).
3. `pnpm --filter @mp/ingredient-parser eval` on the 500-line golden set reports: qty and unit exactly right on ≥ 95% of lines; `ingredientId` right on ≥ 90%; output includes per-stage counts (grammar, lookup, llm).
4. The grammar stage alone (no LLM, no network) handles ≥ 80% of golden lines at confidence ≥ 0.8; the eval shows this number.
5. Running the eval twice makes zero Anthropic calls the second time (cache hit; assert via `ai_runs` count or a mocked client counter).
6. `convert(1, 'cup', 'g', flour)` returns 120–130; `convert(2, 'clove', 'head', garlic)` returns ≤ 1 rounded up by `toPurchasable`; `convert(1.3, 'lb', 'lb', chicken)` via `toPurchasable` returns 1.5. Unit tests cover these plus 20 more cases.
7. Lines "salt and pepper to taste", "1 (14 oz) can diced tomatoes", "2-3 large eggs", "½ cup packed brown sugar, divided" parse to the expected structures (named tests).
8. Unknown ingredient "gochugaru" (if not seeded) produces an `ingredient_alias_proposals` row and a `ParsedIngredient` with `ingredientId = null`, `ingredientName = 'gochugaru'`.
9. `select` on `ingredients` works as an authenticated user; `insert` as an authenticated user is rejected (pgTAP).
10. `pnpm typecheck`, `pnpm lint`, `pnpm test` pass.

## Verification commands
```bash
supabase db reset                                             # 0005 applied, seed loaded
psql "$WORKER_DATABASE_URL" -c "select count(*) from ingredients" -c "select count(*) from ingredient_aliases"
supabase test db                                              # 003 policies pass
pnpm --filter @mp/ingredient-parser eval                      # >=95% qty/unit, >=90% ingredient, stage counts
pnpm --filter @mp/ingredient-parser eval                      # second run: 0 LLM calls
pnpm --filter @mp/core test                                   # units tests pass
pnpm typecheck && pnpm lint && pnpm test
```

## Risks and notes
- No maintained TypeScript ingredient parser exists; the good CRF one (`ingredient-parser-nlp`) is Python at about 94% sentence accuracy. The grammar plus Haiku design is the pragmatic TS path, and its golden set is our regression suite.
- Densities vary by ingredient form (packed vs sifted). Store one representative density and document it; WS05 shows "why this amount" so users can override (R2).
- Use `claude-haiku-5-5` for the fallback; batch 25 lines per call; `strict` schema; log every call to `ai_runs` when WS02's table exists (R3).
- Keep the ontology global. Household-specific aliases (`source = 'user'`) are a later feature; leave room by keeping `source` on the alias table.
- Trigram matching needs `pg_trgm` from WS00's `<timestamp>_extensions.sql`.
- Golden set construction: write the 500 lines by sampling real recipes across cuisines, include units in both abbreviations and words, fractions, ranges, and 50 lines with no quantity. Label by hand or with Opus and then spot-check 100 by hand; say which in the report.
- Mitigates R2, R3; feeds R1 (matching quality starts with correct parsing).

**Suggested build order**
1. Seed CSVs first: 600 ingredients across all 16 categories, aliases for plurals, abbreviations, and common brand-free variants.
2. Migration `0005` plus loader; verify counts.
3. `units.ts` with tests, including the named conversion cases.
4. Grammar stage with 100 golden lines; iterate until ≥80% at confidence ≥0.8.
5. Lookup stage with trigram matching; add aliases the misses reveal.
6. Haiku fallback with strict schema, batching, and cache; prove the second run makes zero calls.
7. Edge Function `parse-ingredients`; proposals table for unknowns.
8. Grow the golden set to 500; hit thresholds; completion report.

## Completion report
End with the completion report from `docs/implementation-guide.md` §6.2 (Message templates). Include the eval summary (thresholds, per-stage counts, cache-hit proof) under Verification output.
