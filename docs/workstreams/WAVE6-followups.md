# Wave 6 follow-ups round

**Wave:** 6 (follow-up round) · **Suggested model:** Sonnet · **Branch:** `ws/w6-followups`

## Goal
Close the small, fully specified items the wave 6 reviews left behind: the household timezone replaces the Pacific and UTC day boundaries that WS12 and WS15 shipped as placeholders, four tests that could not fail now can, the dead-letter retry looks at the whole list, the browser suite's guard covers every page, and a flaky WS08 test becomes deterministic. Nothing here needs an account, a device or a product decision.

## Depends on
- Main at f1e42d0 or later (WS11, WS12, WS13 and WS15 merged; `households.timezone` exists).

## Read first
1. `CLAUDE.md`
2. `docs/02-data-model.md`: the `households` columns (`timezone`), `ai_runs` and the spend functions, the views table
3. `docs/05-security-privacy.md`: spending caps
4. The "Follow-ups recorded after review" sections at the end of `docs/workstreams/WS11-scheduling-notifications.md`, `WS12-history-spend.md`, `WS13-web-desktop.md` and `WS15-observability-evals.md`; this brief names which items are yours
5. `services/shopper-worker/README.md` (dead letter, alert rules) and `e2e-web/README.md` if present, else `e2e-web/support/test.ts`

## In scope
1. **Household timezone for history (WS12 follow-up 2).** New migration `supabase/migrations/20261101100000_household_time_zone.sql`: replace the body of `history_time_zone(household_id uuid)` (today a constant `'America/Los_Angeles'`, created in `20261031180000_ws12_orders_history.sql`) with `coalesce((select h.timezone from public.households h where h.id = household_id), 'America/Los_Angeles')`. Keep `stable`, `set search_path = ''`, and the grants. pgTAP in a new `supabase/tests/w6_followups.sql`: a household with `timezone = 'America/New_York'` puts an order confirmed at 02:30 UTC Monday into the week that Sunday evening Eastern belongs to, while a null-timezone household keeps the Pacific cut. `apps/mobile/src/features/history/SpendTab.tsx` (lines 28 and 56 read `new Date()` in device time): compute "today" in the household's timezone through a zone-aware helper. If `@mp/core` `schedule.ts` already exposes a "local date in zone" helper, use it; otherwise add one exported function `isoDateInZone(now: Date, zone: string | null): string` to `packages/core/src/schedule.ts` with a test across a DST change (this is the one authorized core edit). Read the zone from the household row already loaded by the History screen's hooks; add it to the query if missing.
2. **Household timezone for the cost cap (WS15 follow-up 7).** `createDailyCapGuard` in `packages/llm/src/log.ts` sums spend since UTC midnight. Make the household path use midnight in `households.timezone` (null means America/Los_Angeles): extend the `capFor` lookup in the three function stores (`supabase/functions/recipe-import/store.ts`, `parse-ingredients/store.ts`, `llm-proxy/store.ts`) and the worker's store to return `{ cap, timezone }`, compute `since` in that zone with a dependency-free helper (reuse the one from item 1), and keep the per-user path at UTC midnight. Update docs/02's "The cap day is UTC midnight" sentence. Tests: a household in `Pacific/Auckland` at 23:30 UTC has a different `since` from one in `America/Los_Angeles`.
3. **Spend guard never reads null as zero (WS15 follow-up 2).** In `log.ts` lines 318 and 322 the guard does `Number(await ...)`, and `parse-ingredients/store.ts:214,223` (`Number(data) || 0`), `llm-proxy/store.ts:62` and the recipe-import store coerce a bad RPC answer to 0 before the guard sees it. Accept only a finite number or a non-empty numeric string in the guard; let the stores pass raw values through. Tests: `null`, `""`, `undefined`, `"abc"` and `{}` all refuse with `cost_unknown`; `0`, `"0"` and `1.25` are read as numbers.
4. **`--new-run` looks at the whole list (WS15 follow-up 1).** `services/shopper-worker/src/observability/dlq.ts` around line 155 checks only the archived run's own status. Also refuse when any other run on the same `list_id` is `cart_ready`, `checking_out` or `checked_out`, returning `new_run_refused` with that run's id and status. Tests in `dlq.guards.test.ts`: archived run `failed`, a later run on the list `checked_out`, `--new-run` with and without `--force` refused; the same with the later run `failed` allowed.
5. **Unpinned WS15 hooks (follow-up 3).** Tests that go red when the `report` hook is dropped in `suggest` and `llm-proxy`, and a `suggest` handler test for the ranking fallback on `cost_unknown` (200, `composedBy: "fallback"`, zero model calls).
6. **Self-healed stalls do not page (WS15 follow-up 5).** In the worker's observability reporting, give `swept_requeued` its own tag value and fingerprint, distinct from `no_worker`, and update README alert rule 1 so it names only the paging case. Test: the two events carry different fingerprints.
7. **Release string (WS15 follow-up 6).** `services/shopper-worker/Dockerfile` `ARG GIT_SHA=unknown` makes the Sentry release the string "unknown". Leave the release unset when no SHA is provided (empty default, and the init code treats empty as unset). Test on the init options.
8. **WS11 assertion 258 (WS11 follow-up 1).** `supabase/tests/ws11_schedules_notifications.sql` line 706 asserts `created_by` is null on a schedule that the connection cascade has already deleted, so `is(null, null)` passes. Assert the row count for that case (0, and say why: the deleted person's own connection cascades), add a second schedule that uses another member's connection and assert it survives with `created_by` null, and keep the plan count right. Do not touch the WS11 migration.
9. **Route guard on the context (WS13 follow-up 2).** `e2e-web/support/test.ts` lines 37 and 44 register the non-loopback guard on `page`. Register it on the `context` fixture (`context.route`, `context.routeWebSocket`) so `context.newPage()` is covered, keep the per-test abort recording, and add a static check in `e2e-web/support/exportGuard.test.ts` that no spec uses `browser.newContext(` or the `request` fixture. The suite must still pass and `guard.spec.ts` must still fail on a hosted host.
10. **docs/01 phone-label sentence (WS13 follow-up 1).** `docs/01-architecture.md` line 191 says labels below 768 "are what they were"; three label strings changed on every platform ("Add another recipe to ...", "Open recipe for ...", the Sheet close label "Done, close X"). Reword to say layouts and behavior are unchanged and name the three label changes.
11. **Deterministic WS08 bridge test (WS15 follow-up 10).** `apps/mobile/src/features/tier3/__tests__/bridge.test.ts` sleeps a fixed 400 ms (lines 296, 308, 324) against a 200 ms debounce in `bridge.js:881`. Replace the fixed sleeps with a poll (`waitFor`-style, up to 2 s, 20 ms steps) for the expected event, so a loaded runner cannot fail it. Do not edit `bridge.js`.

## Out of scope
- `households.weekly_nudge` (CCR10), WS06 onboarding creating the default schedule, anything on a device or against a live service, Cloudflare, Sentry or PostHog accounts, the worker deploy.
- Any change to `packages/core` beyond the one helper in item 1, to `packages/retailers`, or to any migration already on main (add new migrations only).
- Reworking WS12's other week cuts (`v_meals_cooked_weekly`, `v_spend_weekly_by_store` already call `history_time_zone`, so item 1 covers them).

## Deliverables
- `supabase/migrations/20261101100000_household_time_zone.sql`, `supabase/tests/w6_followups.sql`, `packages/db/src/types.generated.ts` if the CI diff changes it.
- `packages/core/src/schedule.ts` (one helper) and its test, only if no existing helper fits.
- `packages/llm/src/log.ts` and tests; the three function stores and the worker store with tests; `docs/02-data-model.md` (cap day sentence).
- `services/shopper-worker/src/observability/{dlq,reporting,sentry}.ts` and tests, `Dockerfile`, `README.md`.
- `supabase/functions/suggest` and `llm-proxy` tests.
- `supabase/tests/ws11_schedules_notifications.sql`.
- `e2e-web/support/test.ts`, `exportGuard.test.ts`.
- `docs/01-architecture.md` (one sentence).
- `apps/mobile/src/features/history/SpendTab.tsx` and its test; `apps/mobile/src/features/tier3/__tests__/bridge.test.ts`.

## Interfaces
**Implements:** `history_time_zone(household_id)` now reads `households.timezone`; the cap guard's household `since` is midnight in the household zone.
**Consumes:** `households.timezone` (WS11), `household_ai_spend_since` and `user_ai_spend_since` (WS15), the `test` fixture (WS13). No shared contract changes beyond the authorized core helper.

## Acceptance criteria
1. The new migration applies on CI and `w6_followups.sql` passes; removing the `coalesce` lookup from `history_time_zone` fails the Eastern-week assertion.
2. `SpendTab` shows "Spent this week" for the household zone: a test with the clock at 03:00 UTC Monday and `timezone = 'America/New_York'` picks the previous week; the same clock with `'Asia/Tokyo'` picks the new one.
3. Guard `since` differs by zone (item 2 test); dropping the zone lookup fails it.
4. `null`, `""`, `undefined`, `"abc"`, `{}` from the spend lookup refuse with `cost_unknown` in the guard and through each of the three function stores; restoring `Number(data) || 0` in any store fails its test.
5. `--new-run` refused when another run on the list is `cart_ready`, `checking_out` or `checked_out`, with and without `--force`; removing the list check fails the tests.
6. Dropping `report` in `suggest` or `llm-proxy` fails a test; the `suggest` fallback test passes and fails when the fallback is removed.
7. `swept_requeued` and `no_worker` carry different fingerprints and tags; README rule 1 updated.
8. With no `GIT_SHA`, the Sentry init options carry no `release`.
9. WS11 pgTAP: the own-connection case asserts 0 rows with the reason; the other-member-connection schedule survives with `created_by` null; `plan()` matches; the file passes on PGlite and CI.
10. `corepack pnpm --filter @mp/e2e-web e2e` passes (all specs); a temporary spec that opens `context.newPage()` and fetches a made-up `*.supabase.co` host is aborted and fails (delete it after); the static check rejects a spec containing `browser.newContext(`.
11. `bridge.test.ts` passes 20 times in a row (`vitest --run` in a loop or `--repeat` if available) with no fixed 400 ms sleeps left.
12. `corepack pnpm typecheck && corepack pnpm lint && corepack pnpm test` and `EVAL_REQUIRE_RECORDINGS=1 corepack pnpm eval` pass at the root; `corepack pnpm exec biome check .` is clean; CI green on the pushed head.

## Verification commands
```bash
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck && corepack pnpm lint && corepack pnpm test
EVAL_REQUIRE_RECORDINGS=1 corepack pnpm eval
corepack pnpm exec biome check .
corepack pnpm --filter @mp/e2e-web e2e:build && corepack pnpm --filter @mp/e2e-web e2e
corepack pnpm --filter shopper-worker test                       # dlq, reporting, sentry, pgTAP on PGlite
for i in $(seq 1 20); do corepack pnpm --filter @mp/mobile exec vitest run src/features/tier3/__tests__/bridge.test.ts || break; done
```
No container runtime here: `supabase start`, `db reset` and `test db` run in CI only; the PGlite harnesses in the worker and function tests run the migrations and pgTAP locally.

## Risks and notes
- The hosted project is Miguel's live test bed: create no accounts, write nothing there, never read `.env.local`. The orchestrator applies the new migration after merge.
- Merge `origin/main` before the report; `pnpm-lock.yaml` should not change.
- Mutation evidence is the standard of proof: for each criterion that says "fails when", paste the failing test names.
- Prose style for docs and copy: short sentences, no em dashes, no filler.

## Completion report
End with the completion report format from `docs/implementation-guide.md` §6.2 and nothing else: Built, Files changed, Verification output (real output, including the CI run id), Deviations from brief, Contract change requests, Open issues, Follow-ups.
