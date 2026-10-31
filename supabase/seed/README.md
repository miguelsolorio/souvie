# supabase/seed

SQL seed files that `supabase db reset` loads after the migrations. `config.toml` points `[db.seed] sql_paths` at `./seed/*.sql`, so files load in name order. Prefix them with a number (`10_ingredients.sql`, `20_units.sql`).

What lands here (`docs/01-architecture.md` §Monorepo layout):

- Ingredient ontology and aliases (WS03, below)
- The starter catalog of original dinner recipes (WS16, below)
- Sample recipes (WS02)
- Test households and members for local development and the RLS tests (WS01)

Rules:

- Seeds are for local and CI databases, with two exceptions: the ontology and the starter catalog are global reference data and also have to exist in the hosted project. See "Loading the hosted project".
- No real people, no real retailer accounts, no secrets. Use obviously fake emails such as `owner@example.test`.
- No retailer catalog data. Retailer terms forbid storing it (`docs/04-integrations.md`, `docs/02-data-model.md` §Retention).

## Ingredient ontology (WS03)

| File | Edit by hand? | What it is |
|---|---|---|
| `ingredients.csv` | yes | One row per canonical ingredient |
| `ingredient_aliases.csv` | yes | Every spelling that resolves to an ingredient |
| `10_ingredients.sql` | no | Generated from the two CSVs. `supabase db reset` loads it |
| `load.ts` | | The generator. Also exports `readSeed()` for tests and the eval |

### `ingredients.csv`

| Column | Meaning |
|---|---|
| `name` | Singular, lowercase, unique. The canonical name. |
| `plural` | Plural form, or empty for uncountable items ("flour"). Must not equal another row's name or plural. |
| `category` | One of the 16 store sections: `produce, meat, seafood, dairy, eggs, bakery, pantry, spices, canned, frozen, beverages, snacks, baking, international, household, other`. |
| `default_unit` | The unit recipes usually use. A code from `packages/core/src/units.ts`. |
| `density_g_per_ml` | Grams per milliliter, one representative value (packed brown sugar 0.93, sifted flour 0.53). Empty if unknown. Lets `convert` move between volume and weight. |
| `typical_unit_weight_g` | Grams in one `default_unit` when that is a count unit (a clove of garlic 5, a head of broccoli 300, a bunch of cilantro 30). When `default_unit` is a volume or weight (chicken breast in `lb`), grams in one individual item (225). Empty if unknown. |
| `usda_fdc_id` | Optional FoodData Central id. |
| `is_staple_default` | `true` for items that default to "in the pantry" (salt, oil, flour, sugar, water). |

Ids are not in the CSV. `load.ts` derives each id as a UUID v5 of the name, so the same ingredient has the same id on every machine and in every environment. Never change the namespace in `load.ts`.

### `ingredient_aliases.csv`

Columns `ingredient_name, alias, source`. `ingredient_name` is the canonical `name`. `alias` is lowercase, has no comma, and is unique across the whole file. `source` is `seed` for rows here.

Every ingredient's `name` and `plural` must appear as aliases of itself; a test enforces it. Add the spellings recipes really use: plurals, abbreviations, brand-free variants ("scallion" for "green onion", "garbanzo beans" for "chickpeas").

Do not add aliases that only differ by a word the parser already drops ("fresh", "large", "finely chopped", "boneless"). Do not point an alias at a different product ("pasta sauce" is not "tomato sauce").

### Add or change a row

1. Edit the CSVs.
2. `pnpm seed` (which runs `node supabase/seed/load.ts` and then the catalog loader) rewrites `10_ingredients.sql`. A change to a name can change a catalog recipe's resolved lines: run `pnpm test` to see.
3. `pnpm test` checks the counts, the 16 sections, unit codes, uniqueness, and that the SQL matches the CSVs. `pnpm eval` shows what the change did to the parser.

`pnpm seed:check` fails when either generated SQL file is stale. The SQL is idempotent: it upserts ingredients by name and aliases by alias, and it never touches aliases with `source` other than `seed`.

## Starter catalog (WS16)

A new household has no recipes until it imports some. The catalog gives onboarding's calibration deck and the first drafted week something to work with on day one. It holds original dinner recipes written for this app: `source_type = 'ai'`, `visibility = 'catalog'`, no `household_id`, no `source_url`, no `created_by`, `servings = 4`, and no embedding (WS06's `suggest` backfill fills it when `VOYAGE_API_KEY` is set). Images stay null.

| Path | Edit by hand? | What it is |
|---|---|---|
| `catalog/recipes/<slug>.json` | yes, after review | One recipe: text, tags, and every ingredient line already parsed against the ontology |
| `catalog/spec.ts` | yes | The plan (one slot per recipe), the coverage minimums, the tag vocabulary, the diet and allergen checks, the banned-word lists |
| `catalog/load.ts` | | Renders `20_catalog.sql` and `catalog/README.md` from the JSON. `--check` fails when either is stale |
| `20_catalog.sql` | no | Generated. `supabase db reset` loads it after `10_ingredients.sql` (name order) |
| `catalog/README.md` | no | Generated review sheet: every recipe with cuisine, protein, minutes, diet tags and allergens, then every ingredient line that did not resolve |
| `catalog/catalog.test.ts` | | Asserts the coverage spec, the tag vocabulary, valid recipes, deterministic ids, and that the generated files match the JSON |
| `catalog/draft-log.json` | no | What the drafting runs spent and rejected. The review sheet reads it |

### Rules the catalog keeps

- **Original only.** Drafted from the spec (cuisine, protein, method, time), never from a named source, URL, or third-party text. No chef, publication, restaurant, or brand names; no "copycat" or "famous". `spec.ts` lists the banned words and the test enforces them.
- **Ids are deterministic.** A recipe id is a UUID v5 of its slug under `CATALOG_NAMESPACE`; a line id is a UUID v5 of `<slug>#<position>`; an ingredient id is the ontology's. Local, CI, and hosted databases therefore agree. Never change the namespace. Changing a slug creates a second recipe and retires nothing, so a slug is final once the catalog is loaded anywhere that matters. Until then, a slug must only name words its title uses (a test checks), and renaming one means renaming its file and updating its `PLAN` slot.
- **Tags are checked, not trusted.** Every tag comes from the vocabulary in `spec.ts`. The diet tags (`vegetarian`, `vegan`, `gluten_free`, `dairy_free`) are what the deterministic check finds in the ingredient lines, and the test requires an exact match. The check is conservative: when in doubt the recipe does not get the tag. Gluten doubt covers soy sauce and tamari, broth and stock, pasta and noodles, oats, miso, gochujang, tempeh, and sausages; vegetarian doubt covers broth, fish sauce, Worcestershire sauce, and Parmesan, Pecorino, and Grana Padano (animal rennet). A line clears its doubt only by saying so ("gluten-free tamari", "vegetarian Parmesan"), and then the word stays in the line's `prepNote` too, because its ingredient id alone ("soy sauce") would lose it; a test checks. A recipe with a non-meat protein is vegetarian, and a recipe holds only the meat or fish its protein tag names. Titles and descriptions make no diet or allergen claim, "no sesame" included: the tags carry that.
- **Allergens are named.** Soy sauce, tamari, fish sauce, oyster sauce, Worcestershire sauce, miso, sesame oil, tahini, and nut butters each get their own ingredient line, and the test fails when a step uses one that no line names. Tags are not the enforcement for allergies: WS06 filters on ingredient ids in SQL and again in TypeScript.
- **No slow cooker recipes.** The ceiling is 120 minutes of prep plus cook, so the `slow_cooker` tag is in the vocabulary and unused.

### Review, edit, retire

1. Read `catalog/README.md`. The Allergens column over-reports on purpose (soy sauce counts as soy and wheat).
2. To change a recipe, edit its JSON, then `pnpm seed:catalog` and `pnpm test`. If you change a rule in `spec.ts`, run `pnpm --filter @mp/recipe-import draft-catalog -- --retag` first; it recomputes the diet tags of existing files with no model calls.
3. To drop a recipe before it is loaded anywhere, delete its file. After it is loaded, the SQL never deletes a recipe: set `deleted_at` on the row (as the service role) and delete or keep the file. A file that stays is reloaded as it is, and its `deleted_at` is left alone.
4. The SQL upserts by id, so a reload updates text in place. It keeps a recipe's embedding unless the title, description, tags, or cuisine changed. Its last statement deletes the ingredient lines of the catalog recipes it upserts that the JSON no longer has (below).

### Removing an ingredient line

The procedure for taking a line, an allergen included, out of a database that already has the catalog (a hosted project after the first load):

1. Delete the line from the recipe's JSON `ingredients` and renumber `position` from 0 (line ids are `<slug>#<position>`, so a renumbered line keeps its position's id and is updated in place; the highest old position has no id in the new set).
2. Edit the steps that used it, then run `pnpm seed:catalog` and `pnpm test`.
3. Run `psql "$WORKER_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/seed/20_catalog.sql`. The upserts rewrite the lines, then `delete from public.recipe_ingredients where recipe_id = any (...) and id <> all (...)` removes every line of those recipes whose id is not in the rendered set. That statement is scoped to the catalog recipes the file lists; household recipes are untouched.
4. Check: `select count(*) from public.recipe_ingredients where recipe_id = '<recipe id>'` equals the number of lines in the JSON.

### Drafting more recipes

`packages/recipe-import/scripts/draft-catalog.ts` is a one-time, local script. It reads the plan in `catalog/spec.ts`, asks `claude-sonnet-5-5` for each missing slug (prompt `catalog-draft.v1`), parses every ingredient line with `@mp/ingredient-parser`, computes the diet tags, and writes one JSON file per recipe. It skips slugs that already have a file and refuses to run when `CI` is set. `--max-usd` is a ceiling, not a trigger: each model call, the Haiku ingredient fallback included, books its worst-case cost before it starts and is refused when that would pass the cap, so a run never spends more than the cap and a cap below one recipe's cost spends nothing. The run log goes beside the recipes directory (`catalog/draft-log.json`, or `<out>.draft-log.json` for another `--out`), never inside it, and the loader ignores a stray `draft-log.json`.

```bash
# the key comes from .env.local into this process only
pnpm --filter @mp/recipe-import draft-catalog -- --count 60 --max-usd 5
pnpm --filter @mp/recipe-import draft-catalog -- --only some-slug,other-slug   # redo a slot: delete its file first
node supabase/seed/catalog/load.ts                                              # then re-render the SQL and the sheet
```

To add recipes beyond the plan, add slots to `PLAN` in `spec.ts` (slugs are final once drafted) and run the script with a higher `--count`. A full run of 60 costs about a dollar.

## Loading the hosted project

The hosted database needs the ontology and, once the catalog has been reviewed and approved, the starter catalog. `[db.seed] sql_paths` matches every file in this directory, so `supabase db push --include-seed` would load any file added here, including test data. Load the two reference files explicitly instead, in order, with a session-mode connection (`WORKER_DATABASE_URL`):

```bash
psql "$WORKER_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/seed/10_ingredients.sql
psql "$WORKER_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/seed/20_catalog.sql
```

Both files are idempotent. Do not load `20_catalog.sql` before the person who owns the content has approved `catalog/README.md`. After the first load, the catalog's embeddings are empty until WS06's `suggest` function runs its `backfill` mode.
