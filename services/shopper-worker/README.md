# @mp/shopper-worker

Long-running Node 22 service. It consumes the pgmq queue `shopping_run` (Supabase Queues) and, from WS09 on, runs the shopping agent against a retailer adapter. It runs on Fly.io or Railway in production and with `pnpm dev` locally. See `docs/01-architecture.md` §Why a separate worker.

## Status

Scaffold from WS00. The worker connects to Postgres with postgres.js, logs `connected`, then polls `shopping_run` every 5 seconds and logs `idle` when nothing is waiting. There is no job handler yet. A message that arrives is logged and left in the queue, so pgmq hands it out again after the 30 second visibility timeout.

The queue itself is created by the WS09 `runs` migration (`docs/02-data-model.md` §Migration ownership). Until then the worker logs one warning and keeps logging `idle`.

## Configuration

| Variable | Required | Notes |
|---|---|---|
| `WORKER_DATABASE_URL` | yes | Direct Postgres URL. On a developer machine, the hosted project's connection string. In CI, the DB URL from `supabase status`. |
| `SENTRY_DSN` | no | Read only. Sentry is wired in WS15. |

`pnpm dev` loads the repo root `.env.local` when it exists. `pnpm start` reads only the process environment, which is what production hosts set.

## Scripts

```bash
pnpm --filter @mp/shopper-worker dev        # watch mode, loads ../../.env.local
pnpm --filter @mp/shopper-worker start      # one process, no watch
pnpm --filter @mp/shopper-worker test
pnpm --filter @mp/shopper-worker typecheck
```

## Files

- `src/index.ts`: config, logger, connection with retry, signal handling.
- `src/queue.ts`: pgmq client (`pgmq.list_queues`, `pgmq.read`), the poll loop, the placeholder handler.
