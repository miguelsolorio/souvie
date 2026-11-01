# WS11: Scheduling & notifications

**Wave:** 6 · **Suggested model:** Sonnet · **Branch:** `ws/11-scheduling-notifications`

## Goal
When this is done, a household can say "shop for next week every Saturday at 9am" once and the system does the rest: a cron job finds due schedules, enqueues a shopping run against the right grocery list, and the household gets a push notification when the cart is ready. Five push notification types cover the whole loop, and quiet hours keep them polite. This is the piece that turns the shopping agent (WS09) from a button into a habit.

## Depends on
- WS09 (Shopping agent + worker): the `shopping_runs` table, the `shopping_run` pgmq queue and message shape, and the run status lifecycle (`queued → running → needs_review → cart_ready → ...`). This WS enqueues runs; it never runs them.
- WS05 (Grocery list): `grocery_lists` with `status` and `plan_id`, so a schedule can resolve "the active list for the coming week."
- WS01 (Auth & households): `households`, `household_members`, and the RLS pattern.
- WS00 (Scaffold): Supabase local dev, migration conventions, `packages/db` generated types.

## Read first
1. `docs/01-architecture.md` (Supabase section: Cron, Queues, why a worker)
2. `docs/02-data-model.md` (Retail tables: `shopping_runs`, `scheduled_runs`; Lists: `grocery_lists`)
3. `docs/03-ai-design.md` §4.8 (shopping agent run states and review gate)
4. `docs/04-integrations.md` §5.5 (Tier 3 modes, so you know unattended checkout only exists in Mode B)
5. `docs/06-risks.md` (R10 background jobs stall, R19 hand-off perception)
6. `docs/workstreams/WS09-shopping-agent-worker.md` (Interfaces section only: queue message shape)

## In scope
- `scheduled_runs` table, RLS, and CRUD from the app.
- A pg_cron job (`enqueue_due_scheduled_runs`) that runs every 5 minutes and enqueues one `shopping_run` message per due schedule.
- Resolution logic: given a schedule and "now", pick the household's grocery list for the coming week (status `active`, `plan_id` whose `meal_plans.week_start` is the next Monday on or after the scheduled time). If none exists, create a `shopping_run` with status `failed` and error `no_active_list`, and notify.
- Idempotency: a schedule never enqueues twice for the same `next_run_at`.
- Onboarding default: a suggested schedule "Saturday 9:00am for the week starting Monday" that the user can accept, edit, or skip. The onboarding screen itself belongs to WS06; this WS exposes the `createDefaultSchedule(householdId, tz)` helper and the schedule editor screen.
- Push notifications via Expo Push for exactly five event types:
  1. `cart_ready` with subtotal and store name
  2. `items_need_review` with count
  3. `pickup_reminder` before a recorded pickup window (from `orders.slot_start`, WS12)
  4. `weekly_plan_nudge` when no plan exists for next week by a configurable day/time
  5. `import_finished` when an `import_jobs` row completes
- Push token storage: `push_tokens` table (see Interfaces).
- Quiet hours per household (`households.quiet_hours` jsonb: `{start: "21:00", end: "07:00", tz: "America/Los_Angeles"}`). Notifications due inside quiet hours are deferred to the end of quiet hours, except `items_need_review`, which is still deferred but flagged urgent in the UI.
- Schedule editor screen in `apps/mobile`: cadence (weekly day + time), store connection, policy (budget cap, substitution level), enabled toggle, next run preview.
- Notification preferences screen: per-type on/off, quiet hours.

## Out of scope
- Running the shopping agent or anything inside a run (WS09).
- Selecting a pickup slot or paying. No retailer exposes slot or payment APIs. A scheduled run normally ends at `cart_ready` plus a notification. Unattended checkout exists only in Tier 3 Mode B (WS10).
- Recording orders or pickup windows (WS12). This WS only reads `orders.slot_start` to send the reminder.
- The onboarding flow screens (WS06). This WS provides the helper and the editor screen WS06 links to.
- Email or SMS channels. Push only.
- Marketing or re-engagement campaigns.

## Deliverables
- `supabase/migrations/<timestamp>_scheduled_runs.sql`: `scheduled_runs` table, `push_tokens` table, `households.quiet_hours` column, `notification_preferences` table, RLS policies, indexes.
- `supabase/migrations/<timestamp>_cron_enqueue_scheduled_runs.sql`: the `enqueue_due_scheduled_runs()` SQL function and the `cron.schedule('enqueue-due-scheduled-runs', '*/5 * * * *', ...)` registration.
- `supabase/functions/send-push/index.ts`: Edge Function that takes `{householdId, type, payload}` and fans out to Expo Push, honoring preferences and quiet hours.
- `supabase/migrations/<timestamp>_notification_triggers.sql`: database triggers or a `notification_outbox` table plus pg_cron drain that call `send-push` when `shopping_runs.status` changes to `cart_ready` or `needs_review`, and when `import_jobs.status` becomes `done`.
- `packages/core/src/schedule/`: `nextRunAt(cron, tz, from)`, `resolveTargetList(...)` pure functions with tests.
- `packages/db/src/queries/scheduledRuns.ts`, `packages/db/src/queries/pushTokens.ts`.
- `apps/mobile/app/(app)/settings/schedules/index.tsx` and `[id].tsx`: schedule list and editor.
- `apps/mobile/app/(app)/settings/notifications.tsx`: preferences and quiet hours.
- `apps/mobile/src/notifications/registerPushToken.ts`: registers the Expo push token on sign-in and stores it in `push_tokens`.
- `supabase/tests/scheduled_runs_rls.sql` (pgTAP) and `supabase/tests/enqueue_due_scheduled_runs.sql`.
- `docs/02-data-model.md`: append `push_tokens` and `notification_preferences` to the data model, and add `quiet_hours` to `households`. Mark the edit with the WS number in the commit message.

## Interfaces
**Implements**
- Table `scheduled_runs` (household_id, cron text, tz text, connection_id → retailer_connections, policy jsonb {budget_cap numeric, substitution 'none'|'same-brand'|'any', auto_checkout boolean default false}, next_run_at timestamptz, last_enqueued_for timestamptz, enabled boolean, created_at, updated_at). Unique on (id, last_enqueued_for) is not enough; idempotency is enforced by the update `set last_enqueued_for = next_run_at where last_enqueued_for is distinct from next_run_at` inside the same transaction as the enqueue.
- Table `push_tokens` (id, user_id, household_id, expo_token text unique, platform 'ios'|'android'|'web', last_seen_at, disabled boolean).
- Table `notification_preferences` (household_id, user_id, type text check in the five types, enabled boolean default true), unique (user_id, type).
- Column `households.quiet_hours` jsonb nullable.
- SQL function `enqueue_due_scheduled_runs()` returns integer (count enqueued).
- Edge Function `send-push` POST `{householdId, type, payload}`; returns `{sent: n, deferredUntil?: iso}`.
- Pure functions in `packages/core/src/schedule/`: `nextRunAt(cron: string, tz: string, from: Date): Date`; `resolveTargetWeekStart(runAt: Date, tz: string): Date` (next Monday on or after runAt in tz).

**Consumes**
- pgmq queue `shopping_run` and message shape `{run_id: uuid}` as defined by WS09. The function inserts a `shopping_runs` row with `trigger = 'scheduled'`, `status = 'queued'`, `policy` copied from the schedule, then calls `pgmq.send('shopping_run', jsonb_build_object('run_id', ...))`.
- `shopping_runs.status` transitions written by WS09.
- `orders.slot_start` written by WS12 (for `pickup_reminder`).
- `import_jobs.status` written by WS02.
- Shared contracts in `packages/core` are owned by the orchestrator. If you need a new field on `shopping_runs` or a change to the queue message, stop and file a contract change request.

## Acceptance criteria
1. `supabase db reset` applies all WS11 migrations with no errors and `supabase test db` passes `scheduled_runs_rls.sql` (a member of household A cannot read or write household B's schedules or push tokens).
2. With a schedule whose `next_run_at` is in the past, calling `select enqueue_due_scheduled_runs()` inserts exactly one `shopping_runs` row with `trigger = 'scheduled'` and exactly one message on the `shopping_run` queue (verified with `select * from pgmq.read('shopping_run', 30, 10)`), and advances `next_run_at` to the next occurrence.
3. Calling `enqueue_due_scheduled_runs()` twice in a row for the same due time inserts zero additional runs and zero additional messages.
4. With no active grocery list for the target week, the function inserts a `shopping_runs` row with `status = 'failed'` and `error = 'no_active_list'` and the household receives (or has queued) a `weekly_plan_nudge` notification.
5. `pnpm test --filter core` passes unit tests for `nextRunAt` covering: weekly day+time, DST transitions in America/Los_Angeles (March and November), and a `from` exactly equal to the scheduled time.
6. Updating a `shopping_runs` row to `status = 'cart_ready'` with a `subtotal` results in a `send-push` call whose payload includes the subtotal and store name (verified via the `notification_outbox` row or Edge Function logs in `supabase functions serve`).
7. With `quiet_hours` set to cover "now", a `cart_ready` notification is not sent and `send-push` returns `deferredUntil` equal to the end of quiet hours in the household's timezone.
8. Disabling `items_need_review` in `notification_preferences` for a user results in that user receiving no push for that type while another household member still does.
9. The schedule editor screen creates, edits, disables, and deletes a schedule, and shows the correct next run preview computed by `nextRunAt`.
10. `registerPushToken` stores a token on first sign-in and updates `last_seen_at` on subsequent launches without creating duplicates.
11. `pnpm typecheck && pnpm lint && pnpm test` pass at the repo root.

## Verification commands
```bash
supabase start && supabase db reset            # expected: migrations apply, seeds load
supabase test db                                # expected: all pgTAP tests pass, including WS11 files
psql "$WORKER_DATABASE_URL" -c "select enqueue_due_scheduled_runs();"   # expected: integer count
psql "$WORKER_DATABASE_URL" -c "select msg_id, message from pgmq.read('shopping_run', 30, 10);"  # expected: one row per due schedule
pnpm test --filter core                         # expected: schedule tests pass
supabase functions serve send-push              # then POST a cart_ready payload with curl; expected 200 and {sent: n}
pnpm typecheck && pnpm lint && pnpm test        # expected: clean
pnpm --filter mobile start                      # manual: open Settings → Schedules, create and edit a schedule
```

## Risks and notes
- From the WS01 review (2026-10-30): `households` has column-level UPDATE grants for `authenticated` (`name`, `zip` only). A column you add is not client-editable unless your migration grants `update (<column>)` on it explicitly; otherwise write it through a security-definer function. Add a pgTAP assertion either way. Applies to `quiet_hours`.
- R10 (background jobs stall): the cron function must be short and transactional. Do not call the Edge Function from inside it; write to `notification_outbox` and let a separate 1-minute pg_cron drain call `send-push`. This keeps enqueue and notify independent.
- R19 (hand-off perception): the `cart_ready` notification copy must say what happens next, for example "Your QFC cart is ready ($142.10). Tap to review, then pick a pickup time and pay in the QFC app." Never imply the order was placed.
- Idempotency is the hard part. Use `select ... for update skip locked` on due schedules and advance `next_run_at` and `last_enqueued_for` in the same transaction as the insert and `pgmq.send`.
- Timezones: store `tz` on the schedule, compute everything in that zone, and store timestamps as timestamptz. Default `tz` to the household's zip-derived zone or America/Los_Angeles.
- Expo Push tokens expire. Handle `DeviceNotRegistered` receipts by setting `push_tokens.disabled = true`.
- pg_cron and pgmq must be enabled in `supabase/config.toml` for local dev; WS00 should already have done this. If not, enable them in your migration and note it in the report.
- Unattended checkout is out of scope here. A `scheduled_runs.policy.auto_checkout = true` is only honored by WS10 Mode B and is ignored otherwise.

## Completion report
End with the completion report format from `docs/implementation-guide.md` §6.2 (Message templates). Nothing else is read by the orchestrator.

## Preconditions from the WS09 review (orchestrator, 2026-10-31)

WS09 shipped `push_tokens` and the two run pushes; WS11 extends them. Carry these from the WS09 re-review:
- `apps/mobile/src/features/auth/useSignOut.ts` deletes this device's `push_tokens` row before the session ends, and nothing tests it (removing the call leaves every test green). Add a hook test, and cover a sign-out before registration finishes and a remote or forced sign-out, so no phone keeps receiving "Cart ready" after someone else signs in.
- The review-timeout lower bound in `shopping_runs_clear_expired` is not pinned by pgTAP (a timeout of 0 hours passes because `now()` is constant inside the test transaction); set the fresh run's `status_changed_at` 47 hours back and the stale one 49.
- `useRunRealtime.ts` overlays only the keys a payload carries, but only the pure function is tested; add a hook test.
- A run that times out after a partial push keeps its pushed lines' product and quantity until clearing, and the app's in-cart warning applies only to `failed` runs; extend it to `cancelled` runs with `cart_qty > 0`.
- The sweeper's requeue has no fencing against a paused-but-alive worker; the at-least-once window is the same as the in-flight resend. Acceptable for v1; note it in the ops runbook WS15 writes.
- Not verified on the hosted project yet: Realtime payload completeness, the sweeper's dispatch on real pgmq, PostgREST binding of a JSON null policy, the Docker build, and criteria 12 and 13 (Simulator flow needs `extra.eas.projectId` and a dev build; the live Kroger run needs Miguel's sign-in).

## Orchestrator corrections (2026-10-31, before dispatch)

These override the sections above where they differ.

Shared facts for every wave 6 brief (the as-built repo, 2026-10-31):
- Packages are `@mp/core`, `@mp/db`, `@mp/llm`, `@mp/retailers`, `@mp/agent`, `@mp/ui`, `@mp/mobile`, `@mp/shopper-worker`; use those names in `--filter`. Root `pnpm test` is the Vitest `unit` project (`*.test.ts(x)`), root `pnpm eval` is the `evals` project (`**/evals/**/*.eval.ts`); there is no turbo `eval` task and no `packages/evals`.
- App code lives under `apps/mobile/src/features/<name>/` and routes under `apps/mobile/app/(app)/...`; the repo's platform split is `X.native.tsx` plus an unsuffixed default for web (never `*.web.*`). Screen tests render through the stand-in in `apps/mobile/src/testing/` (render once, no effects; see `pickScreen.test.tsx`).
- `@mp/llm` exports `createAnthropicClient` (not `createClient`), `callWithTools`, `logAiRun`, `toAiRunRow`, `estimateCostUsd`, `createDailyCapGuard` (throws `LlmError("cost_cap")`), `MODELS` and the prompt registry. `@mp/db` exports `createClient` (the supabase wrapper). `@mp/agent` exports `matchLineItems`, `replayRun`, `canAutoCheckout`, the run steps and the types (`TranscriptEntry` is `{ts, tool, by, input, output_summary, ok, screenshot_path?}`). `RunPolicy` keys are snake_case (`budget_cap_usd`, `per_item_ceiling_usd`, `substitution`, `auto_checkout`, `auto_checkout_cap_usd`, `max_tool_calls`, `max_wall_clock_seconds`).
- docs/03 sections are §1 model tiers, §2 onboarding, §3 suggest, §4 import, §5 parsing, §6 list aggregation, §7 line-item conversion, §8 shopping agent, §9 assistant, §10 evaluation harness, §11 safety; docs/04 has no numbers (headings: Feasibility matrix, Adapter contract, Per-retailer adapter plan, Kroger, Costco, Safeway Albertsons Haggen, Tier 3 with "Mode A host as built (WS08)" and "Mode B").
- Tables that exist: everything in docs/02 through `push_tokens`, `shopping_runs` (with `heartbeat_at`, `subtotal_usd`, `store_name`, `error`), `shopping_run_items` (`unit_price_usd`, `line_total_usd`, `cart_qty`, `user_decision`), `households.tier3_consent`, `households.plan_mode`, `ai_runs.run_id`, `recipes.source_url_normalized`. Not yet: `scheduled_runs`, `notification_preferences`, `notification_outbox`, `households.quiet_hours`, `households.ai_daily_cap_usd`, `orders`, any cost view, `shopping_run_dlq` (the dead letter is pgmq's archive `a_shopping_run`). Extensions: pgmq, pg_cron, vector, pg_trgm, pgtap; not pg_net, so SQL cannot call an Edge Function.
- Every migration that touches a table or function must come with `packages/db/src/types.generated.ts` regenerated from the CI artifact ("Check committed types are current" fails otherwise), a `config.toml` section for any new function, a `deno.json` import map, and fixture-scoped pgTAP named `wsNN_<area>.sql`. Parallel builders all touch the generated types and the lockfile: before your report, `git fetch origin && git merge origin/main`, regenerate both rather than hand-merging, and keep both sides.
- CI: job `checks` (typecheck, lint, unit tests, evals with `EVAL_REQUIRE_RECORDINGS=1`, `deno check`) and job `supabase` (stack, migrations, seeds, extension check, schema lint, pgTAP, magic link, health, queue exists, worker poll, worker mock run, list-build on real Postgres, generated types). Extend those jobs; add no new workflow unless the brief says so.
- `instacart` is retired (CCR9, PR #26): never reference it. Checkpoint facts: no container runtime on the dev Mac, CI is the authority; the hosted project is Miguel's live test bed, write nothing there.

WS11-specific:
1. **Versions and paths.** Migration `20261031170000_ws11_schedules_notifications.sql`, pgTAP `ws11_schedules_notifications.sql`. Screens under `apps/mobile/src/features/schedules/` and `features/notifications/`, routes `app/(app)/schedules/{index,[id]}.tsx` and `app/(app)/notifications.tsx`, registered in `(app)/_layout.tsx` and linked from `menu.tsx` and `household/settings.tsx`. Query modules are flat files in `packages/db/src/` (`schedules.ts`, hooks under `hooks/`), not `queries/`. Pure schedule helpers go in `packages/core/src/schedule.ts` (new file, exported from `index.ts` by you as the one authorized core edit; keep core dependency-free, so no cron library).
2. **Tables follow docs/02, not the brief:** enum `notification_type` with `weekly_nudge`; `notification_preferences (user_id, type, enabled)` with pk `(user_id, type)`; `notification_outbox (id, household_id, type, payload, deliver_after, sent_at, attempts)`; `households.quiet_hours jsonb {start, end}` plus a new `households.timezone text` (IANA name, nullable; WS12 reads it later). `push_tokens` exists from WS09 with `(user_id, token, platform, updated_at)`; do not add `household_id`, `expo_token`, `last_seen_at` or `disabled`; registration lives in `apps/mobile/src/features/shopping/PushLifecycle.native.tsx` and a dead token is deleted, not disabled.
3. **No duplicate pushes (decided).** The worker already sends `cart_ready` and `needs_review` straight to Expo (`services/shopper-worker/src/push.ts`). Leave those as they are. The outbox carries the new types only (weekly nudge, run failed, schedule skipped), and the sender is the worker: it drains the outbox on its poll loop with the same Expo client, honouring quiet hours and preferences. There is no `send-push` Edge Function and no pg_net.
4. **Enqueue path (decided).** `scheduled_runs` evaluation is a pg_cron job calling a SQL function `enqueue_due_scheduled_runs()` that calls the existing `enqueue_shopping_run(list_id, connection_id, 'scheduled', policy)` (it accepts `trigger = 'scheduled'` when `auth.uid()` is null and already enforces the daily limit and one active run per list, raising `list_not_found | connection_not_found | connection_inactive | run_in_progress | daily_run_limit | invalid_policy`). A schedule whose connection is a Tier 3 (`browser_session`) connection is skipped with a `schedule skipped` outbox entry, since the worker cannot drive those stores. The policy stored on a schedule uses the real `RunPolicy` keys. There is no `no_active_list` failed run: `shopping_runs.list_id` is not null; record that outcome as a skipped-schedule notification instead.
5. **Week helpers.** `weekStartFor`, `comingWeekStart`, `addDays`, `shiftWeek`, `weekDates` and `isoDateOf` in `@mp/core` take and return `YYYY-MM-DD` strings in device-local time. Your `resolveTargetWeekStart` works in the household's `timezone` and returns the same string shape; put it in `core/schedule.ts`.
6. **Tests from the WS09 review, yours now:** a hook test for `useSignOut` deleting this device's token (plus the sign-out-before-registration and forced sign-out paths); pin the review-timeout lower bound in pgTAP (fresh run 47 hours back, stale 49); a hook test for `useRunRealtime`'s key overlay; extend the in-cart warning to `cancelled` runs with `cart_qty > 0`.
7. **Docs.** docs/03 §8 (not §4.8); docs/04 "Tier 3" (not §5.5); docs/01 "Why a separate worker" and the "Shopping run" key flow.


## Follow-ups recorded after review (2026-11-01, merged 248bc01)

Non-blocking items from the two review rounds, for a later round or for the workstreams named:
1. pgTAP assertion 258 ("the household keeps its schedule") is vacuous for the schedule it creates: a schedule on the deleted person's own connection is removed by the connection cascade, so the subselect is null and `is(null, null)` passes. Assert the row count, run the `created_by` check on a schedule that uses another member's connection, and state the own-connection case explicitly.
2. A failed hold write in `Notifier.notifyRun` drops the push with a warning and no retry (matches WS09's old token-read path). Retry or park the row before giving up.
3. Two reviews held in one night both go out at quiet-hours end; the first is stale in meaning.
4. Cold-start forced sign-out: if the process was killed before it saw signed-in turn into signed-out, `registered` is empty (`pushToken.ts:20`) and the token row stays until someone signs in on that phone.
5. `skip locked` on the scheduler claim and the outbox claim cannot be exercised on PGlite or by the one-worker CI smoke; the worker README records it. A two-connection CI step would pin it.
6. Contract change request accepted in principle: `households.weekly_nudge jsonb {weekday 1..7, time "HH:MM"}` with a CHECK and an owner update grant, read by `enqueue_weekly_nudges` with the Thursday 17:00 fallback. Lands as an orchestrator migration (CCR10) when WS06's onboarding asks for it.
7. For WS15's runbook: the sweeper's at-least-once window, an alert on unsent outbox rows, and the cron jobs `enqueue-due-scheduled-runs`, `notification-generators` and `notification-outbox-prune`.
8. WS06 onboarding calls `createDefaultSchedule` when the person accepts Saturday 9:00; WS12 swaps the body of `history_time_zone()` for `households.timezone`, now on main.
9. The worker is not deployed anywhere, so on the hosted project the scheduler can enqueue runs and generators can write outbox rows that nothing drains until the worker runs.
