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

## The planner (WS04)

| File | What it holds |
|---|---|
| `src/planning.ts` | Query keys, `PlanError`, the typed reads and writes, the pure cache edits, and `PLAN_WRITE_SCOPE` |
| `src/hooks/useMealPlan.ts` | `useMealPlan(weekStart)`: the household's plan for a week, or `null`. Viewing never creates a plan |
| `src/hooks/useMealPlanEntries.ts` | `useMealPlanEntries(planId)`: entries with their recipe (title, picture, times). Also `useRecentRecipeIds` |
| `src/hooks/useUpsertEntry.ts` | `useUpsertEntry()`: add or edit an entry, optimistic, idempotent, with rollback. The first entry of a week creates its plan |
| `src/hooks/useDeleteEntry.ts` | `useDeleteEntry()`: remove an entry, optimistic, with rollback |
| `src/hooks/useRecipeFeedback.ts` | `useRecipeFeedback(recipeId)`, `useSetThumb()` (like or dislike, a state, not an event), `useFavoriteRecipeIds()` |
| `src/realtime/planning.ts` | `usePlanRealtime(householdId)`: one reference-counted channel per household that invalidates `['meal-plan', householdId]` |
| `src/ids.ts` | `newId()` and `setIdGenerator()`: the ids the device picks before the server sees a row |

How a write behaves, and why:

- A new entry is `INSERT ... ON CONFLICT (id) DO NOTHING` with an id the device picked. A retry sends the same id, so a dropped connection never makes a duplicate. An edit is an `UPDATE` of only the changed columns (clients hold column-level privileges and two members editing different fields do not overwrite each other).
- A new week's plan is made with its first entry. If another member made the week first, the insert is refused with `plan_not_found` (the plan id the add carries was never created), and the hook looks the week's plan up again, creating it if nobody did, and retries the insert once.
- An entry's `why` (the one-line reason for a suggested meal) rides on the same writes: a suggested swap sends `{ recipe_id, status, why }`, and a recipe a person picks sends `why: null`.
- Every planner write from a device runs in one TanStack mutation scope, so quick taps are saved in the order they were made. Only the last write of a burst refetches, and the Realtime handler waits for pending writes, so the screen never flickers back to the server's older copy.
- A dropped connection is retried with backoff for about a minute. On the web TanStack pauses the mutation while the browser is offline and resumes it on reconnect. A change is not kept across an app restart; persisting paused mutations needs NetInfo and a mutation persister, which is not wired yet.
- `saved`, `cooked` and `skipped` feedback is written by a database trigger in the same transaction as the entry change. Nothing here writes those three.
- The household is in every query key, and the plan queries are persisted to device storage (`meta.persist`), so a week opens offline and one household's plan cannot appear under another's.
- `['meal-plan', householdId, weekStart]` is the key the grocery list (WS05) listens to. Every entry change invalidates it.

`src/testing/fakeClient.ts` is an in-memory stand-in for the slice of supabase-js these hooks use (rows, filters, upsert with ignore-duplicates, failures, a gate to hold a request in flight). It is for tests and is not exported.

## Types

`src/types.generated.ts` is generated, not edited. The committed file is the output of `supabase gen types typescript` from the CI stack, formatted by Biome. CI regenerates it on every run and fails if it differs from the committed file, and uploads the fresh copy as the `types.generated.ts` artifact. A migration that changes a table or function therefore needs the regenerated file in the same branch.

```bash
pnpm --filter @mp/db gen-types      # local stack (needs supabase start), or the hosted project
                                    # when SUPABASE_PROJECT_REF and SUPABASE_ACCESS_TOKEN are set
```

## Ownership

WS01 adds `types.generated.ts`, `client.ts`, and the identity hooks. WS02 adds the recipe hooks and WS04 the planner hooks. Later workstreams add hooks for the tables they own.

## Scripts

```bash
pnpm --filter @mp/db gen-types
pnpm --filter @mp/db typecheck
pnpm --filter @mp/db lint
pnpm --filter @mp/db test
```
