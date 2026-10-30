# @mp/ui

The design system for `apps/mobile`: tokens, NativeWind primitives, icons, and theming. The one brand color WS00 needs lives in `apps/mobile/tailwind.config.js` until tokens land here.

## Status

Scaffold from WS00. `src/index.ts` exports only `packageName`.

## Ownership

WS04 adds the first primitives (`Sheet`, `Stepper`, `SegmentedControl`, `EmptyState`). WS14 owns brand tokens.

## Scripts

```bash
pnpm --filter @mp/ui typecheck
pnpm --filter @mp/ui lint
pnpm --filter @mp/ui test
```
