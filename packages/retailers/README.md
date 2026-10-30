# @mp/retailers

The `RetailerAdapter` interface (`docs/04-integrations.md` §Adapter contract) and one folder per adapter: `kroger/`, `instacart/`, `browser/`, `mock/`. `mock/` ships fixtures for tests and evals.

## Status

Scaffold from WS00. `src/index.ts` exports only `packageName`. `src/mock/MockRetailer.ts` holds an empty `MockRetailer` class so WS07 has a fixed path. No `RetailerAdapter` type exists yet.

## Ownership

WS07 defines the interface and builds `MockRetailer` and the Kroger adapter. WS08 adds Instacart. WS10 adds browser adapters. The interface is a shared contract: only the orchestrator edits it after WS07 lands.

## Scripts

```bash
pnpm --filter @mp/retailers typecheck
pnpm --filter @mp/retailers lint
pnpm --filter @mp/retailers test
```
