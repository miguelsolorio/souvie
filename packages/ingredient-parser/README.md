# @mp/ingredient-parser

Parses a line such as "2 cups diced yellow onion" into `{ qty, unit, ingredient, prep }`. A deterministic grammar runs first; the model is a fallback with a cache.

## Status

Scaffold from WS00. `src/index.ts` exports only `packageName`.

## Ownership

WS03. Golden-set evals go in `evals/*.eval.ts` and run through `pnpm eval`.

## Scripts

```bash
pnpm --filter @mp/ingredient-parser typecheck
pnpm --filter @mp/ingredient-parser lint
pnpm --filter @mp/ingredient-parser test
```
