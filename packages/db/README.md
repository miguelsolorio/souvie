# @mp/db

Generated Supabase types (`supabase gen types typescript`), a typed `createClient` wrapper, query hooks, and RLS test fixtures. Clients and Edge Functions use the anon key under RLS. The worker uses the service role and must filter by `household_id` explicitly.

## What is here (WS01)

| File | What it holds |
|---|---|
| `src/types.generated.ts` | `Database` types for the identity tables and functions. Regenerate with `gen-types` |
| `src/client.ts` | `createClient(url, anonKey, { storage })`: typed client, PKCE auth, anon key only |
| `src/context.ts` | `SupabaseProvider`, `useSupabase()`. The provider holds the auth session and is the only subscriber to auth changes |
| `src/hooks/useSession.ts` | `useSession()` returns `{ session, user, status }`, where `status` is `loading`, `signed-in`, or `signed-out` |
| `src/hooks/useHousehold.ts` | `useHousehold()` returns the active household and the caller's role. Active means the most recently joined |
| `src/hooks/useHouseholdMembers.ts` | `useHouseholdMembers(householdId)` returns the roster with names and avatar paths |
| `src/hooks/useProfile.ts` | `useProfile()` returns the caller's own profile |
| `src/identity.ts` | Typed calls for the RPCs and tables (`createHousehold`, `redeemInvite`, `uploadAvatar`, ...) and `IdentityError` |

Mount `SupabaseProvider` once, inside the TanStack Query provider. The hooks need React and `@tanstack/react-query` as peers.

## Types

`src/types.generated.ts` is generated, not edited. The committed file is the output of `supabase gen types typescript` from the CI stack, formatted by Biome. CI regenerates it on every run and fails if it differs from the committed file, and uploads the fresh copy as the `types.generated.ts` artifact. A migration that changes a table or function therefore needs the regenerated file in the same branch.

```bash
pnpm --filter @mp/db gen-types      # local stack (needs supabase start), or the hosted project
                                    # when SUPABASE_PROJECT_REF and SUPABASE_ACCESS_TOKEN are set
```

## Ownership

WS01 adds `types.generated.ts`, `client.ts`, and the identity hooks. Later workstreams add hooks for the tables they own.

## Scripts

```bash
pnpm --filter @mp/db gen-types
pnpm --filter @mp/db typecheck
pnpm --filter @mp/db lint
pnpm --filter @mp/db test
```
