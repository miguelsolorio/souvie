# supabase/seed

SQL seed files that `supabase db reset` loads after the migrations. `config.toml` points `[db.seed] sql_paths` at `./seed/*.sql`, so files load in name order. Prefix them with a number (`10_ingredients.sql`, `20_units.sql`).

What lands here (`docs/01-architecture.md` §Monorepo layout):

- Ingredient ontology and aliases (WS03, below)
- Sample recipes (WS02)
- Washington stores for onboarding (WS06, below)
- Test households and members for local development and the RLS tests (WS01)

Rules:

- Seeds are for local and CI databases, with one exception: the ontology is global reference data and also has to exist in the hosted project. See "Loading the hosted project".
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
2. `pnpm seed` (which runs `node supabase/seed/load.ts`) rewrites `10_ingredients.sql`.
3. `pnpm test` checks the counts, the 16 sections, unit codes, uniqueness, and that the SQL matches the CSVs. `pnpm eval` shows what the change did to the parser.

`pnpm seed --check` fails when the SQL is stale. The SQL is idempotent: it upserts ingredients by name and aliases by alias, and it never touches aliases with `source` other than `seed`.

### Loading the hosted project

The hosted database needs the same rows. With `SUPABASE_ACCESS_TOKEN` set and the project linked:

```bash
pnpm supabase db push --include-seed
```

`--include-seed` runs every file matched by `sql_paths`. Today that is only this file. When WS01 and WS02 add seed files for test households and sample recipes, run `psql "$WORKER_DATABASE_URL" -f supabase/seed/10_ingredients.sql` instead so test data stays out of the hosted project.

## Washington stores (WS06)

`stores_wa.csv` is a stopgap list of Washington stores for the onboarding "stores" step: QFC, Fred Meyer, Safeway, Albertsons, Haggen, and Costco, 90 rows. The app bundles it as `apps/mobile/src/features/onboarding/storesWa.generated.ts`, so the step works before a household exists and needs no table.

| Column | Meaning |
|---|---|
| `banner` | `qfc`, `fredmeyer`, `safeway`, `albertsons`, `haggen`, or `costco` |
| `name`, `address`, `zip` | As a store directory lists them. No commas in a field |
| `lat`, `lng` | Approximate: the middle of the store's neighborhood or city. They exist to sort by distance, nothing finer |
| `kroger_location_id` | Kroger's 8 digit location id when known, else empty. Empty on every row today |

Addresses and ZIPs were read from the retailers' own Washington pages and public store directories on 2026-10-30. Stores close and move; the live Kroger lookup (WS07) is the source for QFC and Fred Meyer, and the app uses these rows for them only when it is unreachable. Verify before launch.

A store's id is the Kroger location id when there is one, else `<banner>-<zip>-<street slug>`. That id is what `preferences.primary_store_id` holds. After editing the CSV run `node supabase/seed/stores.ts` to rewrite the module; `node supabase/seed/stores.ts --check` fails when it is stale, and `pnpm test` runs the same check.
