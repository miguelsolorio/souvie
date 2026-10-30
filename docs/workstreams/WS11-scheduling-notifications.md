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
- R10 (background jobs stall): the cron function must be short and transactional. Do not call the Edge Function from inside it; write to `notification_outbox` and let a separate 1-minute pg_cron drain call `send-push`. This keeps enqueue and notify independent.
- R19 (hand-off perception): the `cart_ready` notification copy must say what happens next, for example "Your QFC cart is ready ($142.10). Tap to review, then pick a pickup time and pay in the QFC app." Never imply the order was placed.
- Idempotency is the hard part. Use `select ... for update skip locked` on due schedules and advance `next_run_at` and `last_enqueued_for` in the same transaction as the insert and `pgmq.send`.
- Timezones: store `tz` on the schedule, compute everything in that zone, and store timestamps as timestamptz. Default `tz` to the household's zip-derived zone or America/Los_Angeles.
- Expo Push tokens expire. Handle `DeviceNotRegistered` receipts by setting `push_tokens.disabled = true`.
- pg_cron and pgmq must be enabled in `supabase/config.toml` for local dev; WS00 should already have done this. If not, enable them in your migration and note it in the report.
- Unattended checkout is out of scope here. A `scheduled_runs.policy.auto_checkout = true` is only honored by WS10 Mode B and is ignored otherwise.

## Completion report
End with the completion report format from `docs/implementation-guide.md` §6.2 (Message templates). Nothing else is read by the orchestrator.
