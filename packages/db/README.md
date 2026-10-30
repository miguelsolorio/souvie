# @mp/db

Generated Supabase types (`supabase gen types typescript`), a typed `createClient` wrapper, query hooks, and RLS test fixtures. Clients and Edge Functions use the anon key under RLS. The worker uses the service role and must filter by `household_id` explicitly.

## Status

Scaffold from WS00. `src/index.ts` exports only `packageName`.

## Ownership

WS01 adds `types.generated.ts`, `client.ts`, and the identity hooks. Later workstreams add hooks for the tables they own.

## Scripts

```bash
pnpm --filter @mp/db typecheck
pnpm --filter @mp/db lint
pnpm --filter @mp/db test
```
