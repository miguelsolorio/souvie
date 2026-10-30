# @mp/recipe-import

Turns a URL, pasted text, a photo, or a social caption into a normalized recipe. Scraper first, model extraction as the fallback, ingredient lines parsed by `@mp/ingredient-parser`.

## Status

Scaffold from WS00. `src/index.ts` exports only `packageName`.

## Ownership

WS02. Golden-set evals go in `evals/*.eval.ts` and run through `pnpm eval`.

## Scripts

```bash
pnpm --filter @mp/recipe-import typecheck
pnpm --filter @mp/recipe-import lint
pnpm --filter @mp/recipe-import test
```
