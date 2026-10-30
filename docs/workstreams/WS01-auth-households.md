# WS01: Auth & households

**Wave:** 1 · **Suggested model:** Sonnet · **Branch:** `ws/01-auth-households`

## Goal
Users can sign in with Apple, Google, or an email magic link, create a household or join one through an invite link, and every household-scoped row in the database is protected by Row Level Security that tests prove cannot be crossed. This is the identity layer every later workstream builds on, and it is the first real migration, so it also sets the migration and RLS conventions.

## Depends on
- WS00: monorepo, `apps/mobile` with supabase-js client, `supabase/` local stack, `packages/db` and `packages/core` package shells, Vitest and pgTAP available.

## Read first
1. `docs/02-data-model.md` §Identity and §RLS pattern
2. `docs/05-security-privacy.md` §RLS and §Privacy
3. `docs/01-architecture.md` §Monorepo layout (where screens, hooks, and generated types live)
4. `docs/03-ai-design.md` §4.2 step 1 only (sign in → create or join household is the first onboarding step; WS06 builds the rest)

## In scope
- Migration `<timestamp>_identity.sql` creating `households`, `household_members`, `profiles` with RLS enabled and policies
- A SQL helper function `current_household_ids()` returning the caller's household ids, used by every later policy
- Supabase Auth configuration for Apple (native `expo-apple-authentication` plus OAuth on web), Google, and email magic link
- Screens in `apps/mobile`: sign-in, create household, join household (deep link `mealplanner://join/<token>` and web `/join/<token>`), household settings (rename, members, leave), profile basics (display name, avatar upload to Storage bucket `avatars`)
- Invite tokens: table `household_invites` (household_id, token, created_by, expires_at, used_at) with a `redeem_invite(token)` security-definer function
- `packages/db`: generated Supabase types via `supabase gen types typescript`, a `createClient` wrapper, and typed hooks `useSession`, `useHousehold`, `useHouseholdMembers`
- `packages/core`: zod schemas `Household`, `HouseholdMember`, `Profile`, `ProfilePreferences` (the preferences shape from `docs/02-data-model.md`; WS06 fills it)
- pgTAP tests in `supabase/tests/` proving isolation
- Migration convention documented in `supabase/README.md`: WS01 creates identity tables only; every later workstream adds its own numbered migration for its own tables

## Out of scope
- Onboarding steps 2 through 8 (WS06)
- Any table other than `households`, `household_members`, `profiles`, `household_invites` (each owning WS adds its own)
- Billing, roles beyond `owner` and `member`, multi-tenant admin (v2)
- Retailer OAuth connections (WS07)
- Push notification tokens (WS11)

## Deliverables

- `supabase/functions/export-data/index.ts`: returns a JSON export of everything the calling user and their households own at this point (profile, households, members, invites, audit events). Later workstreams extend it.
- `audit_events` table (see `docs/02-data-model.md`) and writes for member added and removed.
- `supabase/migrations/<timestamp>_identity.sql`
- `supabase/migrations/<timestamp>_identity_functions.sql` (`current_household_ids()`, `redeem_invite(token)`, `create_household(name)`)
- `supabase/tests/001_rls_identity.sql` (pgTAP)
- `supabase/README.md` (migration and RLS conventions)
- `supabase/config.toml` auth section (providers, redirect URLs, magic link template)
- `packages/db/src/types.generated.ts`, `packages/db/src/client.ts`, `packages/db/src/hooks/useSession.ts`, `packages/db/src/hooks/useHousehold.ts`, `packages/db/src/hooks/useHouseholdMembers.ts`
- `packages/core/src/identity.ts` (zod schemas) exported from `packages/core/src/index.ts`
- `apps/mobile/app/(auth)/sign-in.tsx`, `apps/mobile/app/(auth)/callback.tsx`
- `apps/mobile/app/(app)/household/create.tsx`, `apps/mobile/app/(app)/household/settings.tsx`, `apps/mobile/app/join/[token].tsx`
- `apps/mobile/app/(app)/profile.tsx`
- `apps/mobile/src/features/auth/*` (provider buttons, session guard, deep link handling)
- Storage bucket `avatars` with a policy allowing a user to write only `avatars/<user_id>/*`
- `docs/02-data-model.md`: add an "As built" note if any column differs

## Interfaces
**Implements**
- Tables: `households(id uuid pk, name text, zip text, default_store_connection_id uuid null, created_at, updated_at, deleted_at)`; `household_members(household_id, user_id, role text check in ('owner','member'), invited_by uuid null, created_at, primary key (household_id, user_id))`; `profiles(user_id uuid pk references auth.users, display_name text, avatar_url text, preferences jsonb default '{}', created_at, updated_at)`; `household_invites(id, household_id, token text unique, created_by, expires_at, used_at)`
- `current_household_ids()` returns `setof uuid`; standard policy: `household_id IN (select household_id from household_members where user_id = auth.uid())`
- `redeem_invite(token text) returns uuid` (household id); `create_household(name text) returns uuid` (inserts household and owner membership in one transaction)
- zod: `Household`, `HouseholdMember`, `Profile`, `ProfilePreferences` in `@mp/core`
- Hooks in `@mp/db`: `useSession()`, `useHousehold()`, `useHouseholdMembers(householdId)`
- Deep link scheme `mealplanner://` and route `/join/[token]`

**Consumes**
- supabase-js client and env vars from WS00

Shared contracts are owned by the orchestrator. If `ProfilePreferences` needs a shape change, request it in the completion report.

**Example policy and helper**
```sql
create or replace function current_household_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select household_id from household_members where user_id = auth.uid()
$$;

alter table households enable row level security;
create policy households_select on households for select
  using (id in (select current_household_ids()));
create policy households_update_owner on households for update
  using (id in (select household_id from household_members
                where user_id = auth.uid() and role = 'owner'));
```

**Example invite flow**
1. Owner taps "Invite": client calls `rpc('create_invite', { household_id })`, receives `token`, shows `https://<web-origin>/join/<token>` and a share sheet.
2. Invitee opens the link. Web: `/join/[token]` route; native: `mealplanner://join/<token>` via universal link.
3. If signed out, the route stores the token, runs sign-in, then resumes.
4. Client calls `rpc('redeem_invite', { token })`; on success it navigates to `/plan` with the new household active.

## Acceptance criteria
1. `supabase db reset` applies `0000`, `0001`, `0002` with no errors.
2. `supabase test db` runs `001_rls_identity.sql` and all assertions pass, including: user A cannot select user B's household row; user A cannot insert a `household_members` row for a household they do not own; `redeem_invite` with an expired token raises; `redeem_invite` with a valid token adds the caller as `member` and sets `used_at`.
3. On iOS Simulator, tapping "Continue with Apple" completes the native sheet and lands on the create-household screen (screenshot in report). On web, "Continue with Google" completes OAuth and lands on the same screen.
4. Email magic link: entering an email sends a link (visible in `supabase status` Inbucket at `http://localhost:54324`); opening it signs the user in.
5. Creating a household names it and makes the creator `owner` (verified by `select role from household_members`).
6. Generating an invite produces a URL; opening it in a second signed-in session adds that user as `member` and both sessions see the same household name.
7. A `member` cannot rename the household (UI disables it and the policy rejects the update).
8. Uploading an avatar writes to `avatars/<user_id>/...`; a different user's attempt to write to that path is rejected (pgTAP or a scripted test).
9. `pnpm typecheck` passes with `types.generated.ts` regenerated from the local database.
10. `pnpm test` passes including unit tests for the zod schemas.
11. `supabase/README.md` states the migration convention in one paragraph.

## Verification commands
```bash
supabase start && supabase db reset           # exit 0, migrations 0000-0002 applied
supabase test db                              # all pgTAP tests pass
pnpm --filter @mp/db gen-types                # regenerates types.generated.ts
pnpm typecheck && pnpm lint && pnpm test      # exit 0
pnpm --filter @mp/mobile start                # manual: Apple sign-in on iOS, Google on web, magic link via Inbucket
```

## Risks and notes
- Apple sign-in on iOS must use `expo-apple-authentication` and pass the identity token to `supabase.auth.signInWithIdToken`; the OAuth redirect flow is for web only.
- Supabase Auth redirect URLs must include the Expo dev URL, `mealplanner://`, and the web origin; list them in `supabase/config.toml` and `.env.example` comments.
- Never filter household data on the client as a security boundary. The pgTAP tests are the proof; CI must run them from this WS onward (add `supabase test db` to `ci.yml`).
- `profiles.preferences` is per user, not per household, because allergies and dislikes belong to a person. Household-wide settings live on `households`.
- Human checkpoint 2: the orchestrator pauses before merging this WS so the human can approve the first migration and policies.
- Mitigates R9 (sharing permission bugs) and sets up R4 (allergen hard filters live in `preferences`).
- From the WS00 review (2026-10-30): the CI `supabase` job starts the stack with `-x gotrue,realtime,storage-api,imgproxy,mailpit,postgrest,postgres-meta,studio,logflare,vector,supavisor`. Add back the services your pgTAP and auth tests need, at least `gotrue` and `postgrest`. `supabase db lint` in CI is scoped to `--schema public`; add every schema your migrations create (for example the one holding `current_household_ids()`) to that flag. The development Mac has no Docker, so run your own checks against the hosted project per the WS00 amendment and rely on CI for `supabase test db`.

**Suggested build order**
1. Migration `0001` tables and RLS; `0002` functions. Run `supabase db reset`.
2. pgTAP tests first, red; then fix policies until green.
3. Supabase Auth config and redirect URLs; test magic link through Inbucket.
4. `@mp/db` generated types, client wrapper, hooks; `@mp/core` zod schemas with unit tests.
5. Sign-in screen with the three providers; callback route; session guard in `app/(app)/_layout.tsx`.
6. Create household, invite, join, settings, profile screens.
7. Add `supabase test db` to CI; write the completion report.

## Completion report
End with the completion report from `docs/implementation-guide.md` §6.2 (Message templates). Include the pgTAP output and the two sign-in screenshots under Verification output.
