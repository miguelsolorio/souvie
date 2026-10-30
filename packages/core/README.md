# @mp/core

Domain types as zod schemas, unit conversion, list aggregation, and line-item scoring inputs. Pure code only: no network, no database, no React. Every other package depends on it.

## Status

Scaffold from WS00. `src/index.ts` exports nothing yet.

## Ownership

This package is a shared contract. Only the orchestrator edits its exports. A builder that needs a change files a contract change request in its completion report. Table shapes come from `docs/02-data-model.md`. Planned modules: `identity.ts` (WS01), `recipe.ts` (WS02), `units.ts` and `ingredient.ts` (WS03), `planning.ts` (WS04), `list/` (WS05), `preferences.ts` (WS06), `RunPolicy` (WS09).

## Scripts

```bash
pnpm --filter @mp/core typecheck
pnpm --filter @mp/core lint
pnpm --filter @mp/core test
```
