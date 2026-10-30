# @mp/core

Domain types as zod schemas, unit conversion, list aggregation, and line-item scoring inputs. Pure code only: no network, no database, no React. Every other package depends on it.

## Status

WS03 added two modules, exported from `src/index.ts`:

- `units.ts`: the unit dictionary (`UNIT_CODES`, `UNIT_ALIASES`, `normalizeUnit`), `convert(qty, from, to, ingredient)` across volume, weight, and count, and `toPurchasable(qty, unit, ingredient)`, which rounds a recipe amount up to something a person can buy (1.3 lb chicken to 1.5 lb, 2 cloves garlic to 1 head, 1.5 cups flour to 1 bag). `convert` returns null rather than guess when the ingredient lacks the density or unit weight.
- `ingredient.ts`: zod `Ingredient`, `ParsedIngredient`, and the 16 `INGREDIENT_CATEGORIES`.

Relative imports in this package use the `.ts` extension so Supabase Edge Functions (Deno) can load it. Pack sizes and container weights live in tables at the top of `units.ts`; WS05 extends them.

## Ownership

This package is a shared contract. Only the orchestrator edits its exports. A builder that needs a change files a contract change request in its completion report. Table shapes come from `docs/02-data-model.md`. Planned modules: `identity.ts` (WS01), `recipe.ts` (WS02), `units.ts` and `ingredient.ts` (WS03), `planning.ts` (WS04), `list/` (WS05), `preferences.ts` (WS06), `RunPolicy` (WS09).

## Scripts

```bash
pnpm --filter @mp/core typecheck
pnpm --filter @mp/core lint
pnpm --filter @mp/core test
```
