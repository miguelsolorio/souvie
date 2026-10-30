# supabase/seed

SQL seed files that `supabase db reset` loads after the migrations. `config.toml` points `[db.seed] sql_paths` at `./seed/*.sql`, so files load in name order. Prefix them with a number (`10_ingredients.sql`, `20_units.sql`).

What lands here (`docs/01-architecture.md` §Monorepo layout):

- Ingredient ontology and aliases, unit densities (WS03)
- Sample recipes (WS02)
- Test households and members for local development and the RLS tests (WS01)

Rules:

- Seeds are for local and CI databases only. Production data never comes from here.
- No real people, no real retailer accounts, no secrets. Use obviously fake emails such as `owner@example.test`.
- No retailer catalog data. Retailer terms forbid storing it (`docs/04-integrations.md`, `docs/02-data-model.md` §Retention).

WS00 ships no seed files.
