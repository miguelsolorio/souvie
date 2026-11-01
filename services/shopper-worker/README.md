# @mp/shopper-worker

Long-running Node 22 service (WS09). It consumes the pgmq queue `shopping_run` (Supabase Queues), runs `@mp/agent` for each run, writes progress, the transcript and the ledger, sends the run notifications and drains the notification outbox (WS11), and exits cleanly on SIGTERM. It runs on Fly.io or Railway in production and with `pnpm dev` locally. See `docs/01-architecture.md` §Why a separate worker and `docs/03-ai-design.md` §8.

## What one message does

1. `pgmq.read` with a 15 minute visibility timeout claims the message; `store.claim` takes the run row in one conditional update, so two workers never both run it.
2. Not approved yet: the planning phase. Lines, pinned and past choices, every member's allergies and the policy are loaded; `planRun` proposes the cart with no cart write; the proposal is written and the run moves to `needs_review`; the members get "3 items need your call".
3. Approved (`run-approve` set `approved_at` and sent a new message): the push phase. `pushRun` fills the cart through the ledger and the run moves to `cart_ready` with the hand-off link; the members get "Your cart at QFC Duvall is ready ($142.17). Tap to review, then pick a pickup time and pay in the store's app."
4. The message is deleted. A failed attempt is retried after 30 and 60 seconds; the third failure archives the message (the dead letter, `pgmq.a_shopping_run`) and fails the run with the error. A connection that needs a new sign-in fails the run at once.

While a run is held the heartbeat writes `heartbeat_at` and pushes the message's visibility out every `WORKER_HEARTBEAT_SECONDS`. On the same tick the sweeper looks for runs whose heartbeat is older than 90 seconds (`STALE_AFTER_SECONDS`, the same for every worker): an approved push goes back to `queued` with a fresh message and resumes from the ledger, at most twice; anything else is failed. On SIGTERM the poller stops, in-flight runs stop at their next step and go back to `queued` with their messages visible at once, and the process exits within 10 seconds.

## Database access

`WORKER_DATABASE_URL` connects as the database owner. Every statement on an application table runs in a transaction that starts with `set local role service_role`, so the worker has the service role's table privileges and no DDL (`store.test.ts` proves a `create table` fails). The service role has no grant on the `pgmq` schema, so the pgmq calls run as the connection role, outside those transactions. Every query names the household from the claimed run row; the sweeper is the one statement across households, and it writes only `status`, `error` and a `resume` transcript entry.

## Configuration

| Variable | Required | Notes |
|---|---|---|
| `WORKER_DATABASE_URL` | yes | Postgres URL. Hosted: the Supavisor pooler in session mode, port 5432 (postgres.js prepares statements). The transaction pooler on 6543 would need `prepare: false` in `src/index.ts`. In CI: the DB URL from `supabase status`. |
| `WORKER_CONCURRENCY` | no | Runs at once, 1 to 8. Default 2. |
| `WORKER_HEARTBEAT_SECONDS` | no | 5 to 30, so three beats fit inside the sweep threshold. Default 30. |
| `WORKER_OUTBOX_SECONDS` | no | 5 to 300. How often the notification outbox is drained (WS11). Default 30. |
| `WORKER_RETAILER_MODE` | no | `live` (default): Kroger with the credentials below. `mock`: MockRetailer for every store, for local development and the CI smoke run. Refused when `NODE_ENV` is `production`. |
| `ANTHROPIC_API_KEY` | no | The planning loop (Sonnet) and the review summary (Haiku). Without it code picks the close calls and flags them. |
| `AI_DAILY_CAP_USD` | no | A household's model budget per UTC day. Default 2. |
| `KROGER_CLIENT_ID`, `KROGER_CLIENT_SECRET`, `KROGER_API_BASE` | live mode | Refresh tokens come from Vault through WS07's service-role functions. |
| `EXPO_PUSH_ACCESS_TOKEN` | no | Only when the Expo project has enhanced push security on. Used for every push, run or outbox. |
| `SENTRY_DSN` | no | Read only. Sentry is wired in WS15. |

`pnpm dev` loads the repo root `.env.local` when it exists. `pnpm start` reads only the process environment, which is what production hosts set. No secret is logged: the starting line says only whether each is set.

## Notifications (WS11)

Every push goes through `src/notifications.ts`, so a person's switches and the household's quiet hours apply to all of them.

- `cart_ready` and `needs_review` are pushed by the run itself, straight to Expo. Inside the household's quiet hours (`households.quiet_hours`, read in `households.timezone`, default America/Los_Angeles) the push is parked in `notification_outbox` with `deliver_after` set to the end of quiet hours; a held `needs_review` is marked `urgent` (high priority), since the run waits for the person.
- The outbox carries the pushes SQL decides on: `weekly_nudge`, `run_failed`, `schedule_skipped`, `import_finished`, `pickup_reminder` (pg_cron generators and triggers in `20261031170000_ws11_schedules_notifications.sql`). Every `WORKER_OUTBOX_SECONDS` the worker takes the due rows with `for update skip locked`, moves a row due inside quiet hours to their end (no attempt counted), and leases the others for 5 minutes while it sends. A failed send is retried after the lease, five attempts at most; a payload that is not a `core.NotificationPayload` is never sent. A held run push whose run has moved on (the person approved it in the app) is dropped as stale.
- The recipients are the household's members who have not turned the type off in `notification_preferences` (no row means on). A token Expo reports as `DeviceNotRegistered` is deleted. A row for a household with no devices is marked sent.
- Pushes carry the store and the total, never an item (docs/05). `cart_ready` says what happens next: review, then pick a pickup time and pay in the store's app (R19).

## Local development with the mock store

The development Mac has no container runtime, so a local run uses the hosted project once its migrations are pushed. To try the whole flow with MockRetailer, give a household a mock connection (as the database owner; clients cannot insert connections):

```sql
insert into public.retailer_connections (household_id, user_id, retailer, auth_type, store_id, store_name, status)
values ('<household>', '<member>', 'kroger', 'none', 'MOCK0001', 'Mock QFC Duvall', 'active');
```

then run `WORKER_RETAILER_MODE=mock pnpm --filter @mp/shopper-worker dev` and tap "Shop this list" in the app.

## Deploy

```bash
docker build -f services/shopper-worker/Dockerfile -t shopper-worker .     # from the repo root
fly deploy . --config services/shopper-worker/fly.toml --dockerfile services/shopper-worker/Dockerfile
```

`railway.json` is the Railway alternative (Dockerfile builder, 10 second drain). Secrets go in the host's secret store, never in these files.

## Scripts

```bash
pnpm --filter @mp/shopper-worker dev        # watch mode, loads ../../.env.local
pnpm --filter @mp/shopper-worker start      # one process, no watch
pnpm --filter @mp/shopper-worker test       # PGlite with the real migrations, MockRetailer
pnpm --filter @mp/shopper-worker typecheck
services/shopper-worker/scripts/smoke.sh    # CI: a mock run end to end on the local stack
```

## Files

- `src/index.ts`: config, logger, connection with retry, wiring, signal handling.
- `src/queue.ts`: the pgmq client, the poll loop, ack, retry and dead letter.
- `src/runner.ts`: one message, one run phase.
- `src/store.ts`: every SQL statement, under `service_role`.
- `src/heartbeat.ts`: the heartbeat and the stalled-run sweeper.
- `src/shutdown.ts`: SIGTERM, the drain, and the forced hand-back.
- `src/adapters.ts`, `src/models.ts`, `src/push.ts`, `src/config.ts`: the Kroger or mock adapter, the guarded model calls, the words of every push and the Expo call, the environment.
- `src/notifications.ts`: who gets which push and when (WS11). `Notifier` sends a run's push to the members who want it, or parks it in the outbox inside quiet hours; `OutboxDrain` sends what is due; `NotificationStore` holds the SQL.
