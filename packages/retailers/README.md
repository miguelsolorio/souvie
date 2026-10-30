# @mp/retailers

The `RetailerAdapter` contract (`docs/04-integrations.md` §Adapter contract) and one folder per adapter: `kroger/`, `instacart/` (WS08), `browser/` (WS10), `mock/`.

## Entry points

| Import | What | Who uses it |
|---|---|---|
| `@mp/retailers` | Types (`RetailerAdapter`, `Product`, `Store`, `CartItemDelta`, ...), the registry (`getAdapter`, `isAdapterAvailable`, `listAdapters`), typed errors (`RetailerAuthError`, `RetailerQuotaError`, `RetailerNotSupportedError`, ...), the capability table, `ProductRef`, `bannerForChain` | Everyone, the app included. No network, no secrets |
| `@mp/retailers/kroger` | `KrogerAdapter` and its parts: OAuth, Locations, Products, Cart, quota, cache | The worker (WS09) and the `retailer-oauth` Edge Function. Never the app |
| `@mp/retailers/kroger/terms` | `assertDisplayUnchanged`, `formatPrice`, `rememberReturned` | Components that render Kroger data |
| `@mp/retailers/mock` | `MockRetailer` and 224 fictional fixture products | Tests, evals, WS09 replays |

Relative imports carry the `.ts` extension so the Edge Function (Deno) can load these files by path.

## Kroger rules this package enforces

- Catalog calls use the app's `client_credentials` token (`product.compact`). Cart calls use the customer's token (`cart.basic:write`), refreshed from the refresh token in Vault. Kroger reissues the refresh token on every refresh, so every refresh rotates the Vault secret. Access tokens stay in memory.
- Every Products call sends `filter.locationId`. Batch lookups send at most 50 ids per call.
- `quota.ts` counts calls per endpoint per UTC day in `retailer_quota_usage` and throws `RetailerQuotaError` at 95% of the budget, before the network.
- `cache.ts` honors `Cache-Control` and `Expires` only. No TTL of ours. `Product.cacheUntil` carries the result. Kroger sent no cache headers when checked on 2026-10-30, so in practice nothing is cached.
- `terms.ts` records every product as returned. `assertDisplayUnchanged` fails when a name, brand, size, price, or image no longer matches.
- Nothing here writes search results or catalog data anywhere.

## Live smoke test

```bash
pnpm --filter @mp/retailers kroger:login                      # once: your own refresh token into .env.kroger.local
KROGER_LIVE_TEST=1 pnpm test --filter retailers -- kroger.live # stores near 98019, "milk", one cart add
```

It reads the Kroger keys from the environment or the repo's `.env.local` (`KROGER_ENV_FILE` points elsewhere). The cart step runs only when a refresh token is present, and adds one real item to your own Kroger cart. CI never sets `KROGER_LIVE_TEST`.

## Ownership

WS07 built the contract, `MockRetailer`, and the Kroger adapter. WS08 adds Instacart. WS10 adds browser adapters. The contract is shared: only the orchestrator edits it now.

## Scripts

```bash
pnpm --filter @mp/retailers typecheck
pnpm --filter @mp/retailers lint
pnpm --filter @mp/retailers test
```
