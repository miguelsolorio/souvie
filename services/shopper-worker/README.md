# @mp/shopper-worker

Long-running Node 22 service (WS09). It consumes the pgmq queue `shopping_run` (Supabase Queues), runs `@mp/agent` for each run, writes progress, the transcript and the ledger, sends the two run notifications, and exits cleanly on SIGTERM. It runs on Fly.io or Railway in production and with `pnpm dev` locally. See `docs/01-architecture.md` §Why a separate worker and `docs/03-ai-design.md` §8.

## What one message does

1. `pgmq.read` with a 15 minute visibility timeout claims the message; `store.claim` takes the run row in one conditional update, so two workers never both run it.
2. Not approved yet: the planning phase. Lines, pinned and past choices, every member's allergies and the policy are loaded; `planRun` proposes the cart with no cart write; the proposal is written and the run moves to `needs_review`; the members get "3 items need your call".
3. Approved (`run-approve` set `approved_at` and sent a new message): the push phase. `pushRun` fills the cart through the ledger and the run moves to `cart_ready` with the hand-off link; the members get "Cart ready at QFC Duvall, $142.17. Review and pay."
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
| `WORKER_RETAILER_MODE` | no | `live` (default): Kroger with the credentials below. `mock`: MockRetailer for every store, for local development and the CI smoke run. Refused when `NODE_ENV` is `production`. |
| `ANTHROPIC_API_KEY` | no | The planning loop (Sonnet) and the review summary (Haiku). Without it code picks the close calls and flags them. |
| `AI_DAILY_CAP_USD` | no | A household's model budget per UTC day when its own cap (`households.ai_daily_cap_usd`, default 2.00) cannot be read. Default 2. |
| `KROGER_CLIENT_ID`, `KROGER_CLIENT_SECRET`, `KROGER_API_BASE` | live mode | Refresh tokens come from Vault through WS07's service-role functions. |
| `EXPO_PUSH_ACCESS_TOKEN` | no | Only when the Expo project has enhanced push security on. |
| `SENTRY_DSN` | no | The worker's Sentry project. Without it Sentry stays off. See Observability. |
| `SENTRY_ENVIRONMENT` | no | Sentry environment. Default `NODE_ENV`. |
| `GIT_SHA` | no | The Sentry release. The Dockerfile sets it from `--build-arg GIT_SHA=$(git rev-parse HEAD)`. |
| `POSTHOG_API_KEY`, `POSTHOG_HOST` | no | PostHog project key (events and flags). Without the key nothing is sent and every flag reads as on. Host defaults to `https://us.i.posthog.com`. |

`pnpm dev` loads the repo root `.env.local` when it exists. `pnpm start` reads only the process environment, which is what production hosts set. No secret is logged: the starting line says only whether each is set.

## Observability (WS15)

`src/observability/` is mounted by one call in `src/index.ts`. It wraps the runner's `handle` and `onFailure` and the logger on the instances, so the runner, the queue and the store are as WS09 wrote them. Everything is off without its key: no `SENTRY_DSN` and no Sentry SDK is loaded, no `POSTHOG_API_KEY` and nothing is sent.

**What Sentry gets.** The release (`GIT_SHA`), the environment, a `household_id` tag and a `run_id` tag, and the stack. `scrub.ts` runs in `beforeSend` and `beforeSendTransaction`: it removes the user, request bodies, headers, cookies, query strings and host name, the value of any key named like a secret or a query string, and in every string the emails, JWTs, `Bearer` and `Basic` credentials, `Cookie:` and `Set-Cookie:` lines, known key shapes, DSNs, database URLs, US phone numbers and the values after a `?` or `&`. It does not know a product name or a street address: the worker keeps those out by what it sends (ids, counts and short codes as `extra`), never a prompt, a model answer, a recipe or a list.

**Spans.** The SDK runs with `traceLifecycle: 'static'`, so a run is a transaction that carries its spans and `beforeSendTransaction` runs (the SDK's default, `'stream'`, sends spans on their own and skips it). `beforeSendSpan` and `scrubSpanData` drop every `url.*` and `http.*` attribute of a span except the method, the status code, the scheme and the host, keep a URL without its query, fragment and credentials, and drop the peer's address and port. A Kroger search therefore reaches Sentry as `GET https://api.kroger.com/v1/products` with a status code, never with `filter.term`. `src/observability/sentry.sdk.test.ts` starts the real SDK and proves it.

| Event | When | Level |
|---|---|---|
| `run_stalled`, reason `no_worker` | A run is still `running` or `checking_out` 10 minutes after its last heartbeat, and no worker swept it | error |
| `run_stalled`, reason `swept_failed` or `swept_requeued` | The 90 second sweeper failed or resumed a run whose worker stopped beating | error, warning |
| `run_dead_lettered` | The third failed attempt: the message is archived and the run is failed | error |
| `run_failed` | A run ended `failed` | warning |
| `worker_error` | An error log line the runner does not already report (a failed poll, a failed heartbeat), once per 5 minutes per line | error |
| an exception | Every failed attempt of a message, with its stack | warning, error on the last |

Each handled message is one Sentry transaction, `shopping_run`. It is marked failed when the message throws or the run ends `failed`, except for a failure the household fixes itself (`needs_reauth`, `connection_*`, `agent_disabled`), so the transaction failure rate is the worker's error rate.

**What PostHog gets.** `run_started` (every run, manual or scheduled, when a worker first takes it: `{retailer, trigger}`) and `cart_ready` (`{retailer, items, subtotal_bucket}`), with the household id as the distinct id and as the `household` group. The other five events come from the app. Properties are counts, booleans and small enums; a key that is not on the event's list is dropped (`events.ts`). A price is a bucket (`under_50`, `50_100`, `100_150`, `150_200`, `over_200`), never a number.

**Flags.** `getFlag(name, householdId)` follows the kill-switch rule from WS08: on unless PostHog answers an explicit `false` (or, for `tier3_browser_checkout`, a payload `{"off": ["costco"]}` naming the retailer). A worker with no key, no network or a slow answer reads every flag as on. `shopping_agent_enabled` is enforced here: with it off, a run waiting for a worker is failed with `agent_disabled` instead of started, and the app shows that run the same "Shopping is paused right now" copy it shows before a run starts.

### Heartbeat semantics and run health (R10)

There are two layers and they cover different failures.

1. **The sweeper (WS09, `src/heartbeat.ts`).** A worker beats `shopping_runs.heartbeat_at` every `WORKER_HEARTBEAT_SECONDS` (at most 30) while it holds a run. Any live worker fails or resumes a run whose heartbeat is older than 90 seconds. A run waiting for a human is `needs_review`, never `running`, so it is never swept.
2. **The stall watch (WS15, `src/observability/heartbeat.ts`).** The sweeper needs a live worker. Every minute each worker looks for a run still `running` or `checking_out` with no heartbeat for 10 minutes (a run waiting for a worker is measured from its last status change) and reports it as `run_stalled` once per run per process. The same query is the view `v_runs_stalled`, for a dashboard: `select * from v_runs_stalled;`. Each look also checks in to the Sentry Cron Monitor `shopper-worker`; when every worker is down the missed check-ins raise the alert instead.

### Sentry alert rules (configured in the Sentry UI by the human)

Create two projects, `souvie-app` (React Native) and `souvie-worker` (Node), and put each DSN where `.env.example` says. In `souvie-worker`:

1. **Stalled run.** Alerts, Create Alert, Issues. Environment: production. When: *A new issue is created*. If: *The event's tags match* `event` *equals* `run_stalled`. Then: notify Miguel (email, or Slack). Action interval: 5 minutes. Each stalled run has its own issue (fingerprint `run_stalled` and the run id), so every run alerts once.
2. **Dead letter.** The same rule with `event` equals `run_dead_lettered`.
3. **Worker error rate.** Alerts, Create Alert, Metric. Dataset: Transactions. Query: `transaction:shopping_run`. Aggregate: `failure_rate()`. (The static trace lifecycle is what fills the Transactions dataset; `sentry.sdk.test.ts` checks that a run arrives as a `transaction` and that a failed one carries a status the failure rate counts.) Time window: 10 minutes. Critical when above `0.05`, resolved when `0.05` or below. Environment: production. With few runs a single failure is above 5%; that is the setting the brief asks for.
4. **No worker alive.** Crons, `shopper-worker` (created by the first check-in): expected every 1 minute, margin 4 minutes, failure issue threshold 1. A missed check-in opens an issue; add an Issues alert with *A new issue is created* and the filter `issue.category:cron` to the same notification.

### The dead letter queue

There is no separate queue. A message is archived after its third failed attempt, and pgmq keeps it in `pgmq.a_shopping_run`: that archive is the dead letter. The run is `failed` by then (`error` says why).

```bash
pnpm --filter @mp/shopper-worker dlq:list
pnpm --filter @mp/shopper-worker dlq:retry <msg_id> [--new-run] [--force]
```

`dlq:list` prints each message, its run's status and the run's error. `dlq:retry` puts the message back on `shopping_run` when its run can still be claimed (`queued`, or `running` with no heartbeat) and removes it from the archive. A `failed` run cannot be revived (the state machine has no way out of `failed`), so for a closed run the command says so and exits 1. Its options:

- `--new-run` starts a replacement run of the same list and store through `enqueue_shopping_run`. It is for a run that ended without a cart: `failed` or `cancelled`. It is refused, with or without `--force`, for `queued`, `running`, `needs_review`, `cart_ready`, `checking_out` and `checked_out`: a second run on the same list could shop it again or place a second order. The replacement keeps the old policy except that `auto_checkout` is off and `auto_checkout_cap_usd` is null, so the replacement never checks out by itself. A run whose record is gone has no list to copy, so nothing starts.
- `--force` re-sends the message although its run is closed (a worker acks it as not claimable). It does not lift the `--new-run` refusal.
- Whichever you use, the retry refuses when the run already has a live message on `shopping_run` (two messages would let two workers take one run). The check and the send happen under an advisory lock on the run id, so two retries at once cannot both pass it. The refused dead letter stays in the archive.

Both commands connect with `WORKER_DATABASE_URL` as the database owner, because pgmq belongs to that role.

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
pnpm --filter @mp/shopper-worker dlq:list   # the dead letter queue (WS15)
pnpm --filter @mp/shopper-worker dlq:retry <msg_id> [--new-run] [--force]
```

## Files

- `src/index.ts`: config, logger, connection with retry, wiring, signal handling.
- `src/queue.ts`: the pgmq client, the poll loop, ack, retry and dead letter.
- `src/runner.ts`: one message, one run phase.
- `src/store.ts`: every SQL statement, under `service_role`.
- `src/heartbeat.ts`: the heartbeat and the stalled-run sweeper.
- `src/shutdown.ts`: SIGTERM, the drain, and the forced hand-back.
- `src/adapters.ts`, `src/models.ts`, `src/push.ts`, `src/config.ts`: the Kroger or mock adapter, the guarded model calls, Expo push, the environment.
- `src/observability/`: `sentry.ts`, `posthog.ts`, `flags.ts`, `scrub.ts`, `events.ts`, `instrument.ts` (the wrappers), `heartbeat.ts` (the stall watch), `dlq.ts`, `index.ts` (the mount).
- `scripts/dlq.ts`: `dlq:list` and `dlq:retry`.
