// What the worker reports about a run, without touching the runner (WS15). The runner already
// exposes two public entry points: `handle` (one queue message) and `onFailure` (every failed
// attempt). `instrumentRuns` wraps both on the instance, so the runner, the queue and the store
// stay as WS09 wrote them:
//
//   handle      reads the run before and after, and turns what changed into product events
//               (run_started when a worker first takes a run, cart_ready when the push finishes),
//               a Sentry `run_failed` event when the run ends failed, and one Sentry transaction
//               per message, marked failed when the run failed, so Sentry's failure rate is the
//               worker's error rate. With the shopping_agent_enabled kill switch off, a claimable
//               run is failed with a clear reason instead of started.
//   onFailure   reports every failed attempt to Sentry with the run id and household id, and the
//               last one as `run_dead_lettered`.
//
// `instrumentLogger` reports the worker's own error logs (a failed poll, a failed heartbeat) and
// the sweeper's findings (a run it failed or resumed because its worker stopped beating).
import { errorMessage, type Logger, type QueueMessage } from "../queue.ts";
import { parseRunMessage, type RunRunner } from "../runner.ts";
import type { RunStore } from "../store.ts";
import { subtotalBucket } from "./events.ts";
import type { Analytics } from "./posthog.ts";
import type { ErrorReporter } from "./sentry.ts";

export interface RunSnapshot {
  runId: string;
  householdId: string;
  retailer: "kroger" | "safeway" | "costco";
  trigger: "manual" | "scheduled";
  status: string;
  /** The push phase: the review gate has been passed. */
  approved: boolean;
  /** A worker may take it: queued, or approved and running with no heartbeat. */
  claimable: boolean;
  subtotalUsd: number | null;
  /** Lines with a product in the cart or proposal (matched or substituted). */
  items: number;
  error: string | null;
}

interface SnapshotRow {
  id: string;
  household_id: string;
  retailer: RunSnapshot["retailer"];
  trigger: RunSnapshot["trigger"];
  status: string;
  approved: boolean;
  claimable: boolean;
  subtotal_usd: number | null;
  items: number;
  error: string | null;
}

/** One run's state, by id. Null when the run is gone or the read fails: observing never breaks a run. */
export async function readRunSnapshot(
  store: Pick<RunStore, "inServiceRole">,
  runId: string,
): Promise<RunSnapshot | null> {
  try {
    const rows = await store.inServiceRole((tx) =>
      tx.query<SnapshotRow>(
        `select r.id, r.household_id, r.retailer::text as retailer, r.trigger::text as trigger,
                r.status::text as status, (r.approved_at is not null) as approved,
                (r.status = 'queued' or (r.status = 'running' and r.heartbeat_at is null)) as claimable,
                r.subtotal_usd::float8 as subtotal_usd, r.error,
                (select count(*)::integer from public.shopping_run_items i
                  where i.run_id = r.id and i.household_id = r.household_id
                    and i.status in ('matched', 'substituted')) as items
           from public.shopping_runs r
          where r.id = $1::uuid`,
        [runId],
      ),
    );
    const row = rows[0];
    if (!row) return null;
    return {
      runId: row.id,
      householdId: row.household_id,
      retailer: row.retailer,
      trigger: row.trigger,
      status: row.status,
      approved: row.approved,
      claimable: row.claimable,
      subtotalUsd: row.subtotal_usd,
      items: row.items,
      error: row.error,
    };
  } catch {
    return null;
  }
}

/** The product events and the failure event that follow from a run moving from `before` to `after`. */
export function reportTransitions(
  before: RunSnapshot | null,
  after: RunSnapshot | null,
  deps: { analytics: Analytics; reporter: ErrorReporter },
): void {
  if (!before || !after) return;
  const { analytics, reporter } = deps;
  // The planning phase begins: a worker took a queued run and did not hand it straight back.
  if (before.status === "queued" && !before.approved && after.status !== "queued") {
    analytics.track.runStarted(after.householdId, {
      retailer: after.retailer,
      trigger: after.trigger,
    });
  }
  if (after.status === "cart_ready" && before.status !== "cart_ready") {
    analytics.track.cartReady(after.householdId, {
      retailer: after.retailer,
      items: after.items,
      subtotal_bucket: subtotalBucket(after.subtotalUsd),
    });
  }
  if (after.status === "failed" && before.status !== "failed") {
    reporter.captureEvent("run_failed", {
      householdId: after.householdId,
      runId: after.runId,
      level: "warning",
      tags: { retailer: after.retailer, trigger: after.trigger },
      // The worker's own failure text: a code and a sentence, no list or product data.
      extra: { error: after.error ?? "unknown" },
      fingerprint: ["run_failed", after.runId],
    });
  }
}

/** Failure codes (the text before the first colon of shopping_runs.error) the household can fix. */
export const HOUSEHOLD_FIXABLE =
  /^(needs_reauth|connection_missing|connection_revoked|connection_needs_reauth|connection_unusable|agent_disabled)$/;

export const AGENT_DISABLED_ERROR =
  "agent_disabled: shopping is switched off right now. Try again later.";

export interface InstrumentRunsOptions {
  runs: Pick<RunRunner, "handle" | "onFailure">;
  store: Pick<RunStore, "inServiceRole" | "fail">;
  analytics: Analytics;
  reporter: ErrorReporter;
  log: Logger;
}

export interface Instrumented {
  /** Messages being handled right now. */
  inFlight(): number;
}

export function instrumentRuns(options: InstrumentRunsOptions): Instrumented {
  const { runs, store, analytics, reporter, log } = options;
  const handle = runs.handle;
  const onFailure = runs.onFailure;
  let inFlight = 0;

  runs.handle = async (message: QueueMessage, signal: AbortSignal) => {
    // Counted from the first line, so a shutdown that arrives while the run is being read waits.
    inFlight += 1;
    try {
      const runId = parseRunMessage(message.message);
      const before = runId ? await readRunSnapshot(store, runId) : null;

      if (runId && before?.claimable) {
        const enabled = await analytics.flags.getFlag("shopping_agent_enabled", before.householdId);
        if (!enabled) {
          await store.fail(runId, AGENT_DISABLED_ERROR);
          log.warn("run refused: shopping_agent_enabled is off", { runId });
          return "done";
        }
      }

      return await reporter.traceRun(
        "shopping_run",
        { householdId: before?.householdId, runId },
        async (span) => {
          const outcome = await handle(message, signal);
          const after = runId ? await readRunSnapshot(store, runId) : null;
          reportTransitions(before, after, { analytics, reporter });
          if (after?.status === "failed" && before?.status !== "failed") {
            // A run the household has to fix (a store sign-in that expired) is not a worker error:
            // it still gets its run_failed event, but the transaction stays out of the error rate.
            const code = after.error?.split(":")[0] ?? "failed";
            if (!HOUSEHOLD_FIXABLE.test(code)) span.fail(code);
          }
          return outcome;
        },
      );
    } finally {
      inFlight -= 1;
    }
  };

  runs.onFailure = async (message: QueueMessage, error: unknown, final: boolean) => {
    const runId = parseRunMessage(message.message);
    const snapshot = runId ? await readRunSnapshot(store, runId) : null;
    const context = {
      householdId: snapshot?.householdId,
      runId,
      level: final ? ("error" as const) : ("warning" as const),
      tags: { attempt: String(message.readCount), final: String(final) },
      extra: { msg_id: message.msgId },
    };
    reporter.captureException(error, context);
    if (final) {
      reporter.captureEvent("run_dead_lettered", {
        ...context,
        extra: { ...context.extra, error: errorMessage(error) },
        fingerprint: ["run_dead_lettered", runId ?? message.msgId],
      });
    }
    await onFailure(message, error, final);
  };

  return { inFlight: () => inFlight };
}

/** Error logs that onFailure already reports, so the logger does not send them a second time. */
const COVERED_BY_ON_FAILURE = new Set([
  "message failed, will retry",
  "message failed for the last time, dead-lettered",
]);

/** The same error text is sent at most once in this long. */
export const LOG_EVENT_THROTTLE_MS = 5 * 60_000;

/**
 * Reports the worker's own error logs, throttled per message, and the sweeper's findings.
 * It wraps `error` and `warn` on the logger object in place, because every part of the worker
 * holds that one object. The log line is written first, unchanged.
 */
export function instrumentLogger(
  log: Logger,
  reporter: ErrorReporter,
  options: {
    now?: () => number;
    /** The household of a run, for the tag on a sweeper event. */
    householdOf?: (runId: string) => Promise<string | null>;
  } = {},
): void {
  const now = options.now ?? Date.now;
  const writeError = log.error.bind(log);
  const writeWarn = log.warn.bind(log);
  const lastSent = new Map<string, number>();

  log.error = (message, fields) => {
    writeError(message, fields);
    if (COVERED_BY_ON_FAILURE.has(message)) return;
    const at = now();
    const last = lastSent.get(message);
    if (last !== undefined && at - last < LOG_EVENT_THROTTLE_MS) return;
    lastSent.set(message, at);
    reporter.captureEvent("worker_error", {
      level: "error",
      tags: { log: message },
      ...(fields ? { extra: fields } : {}),
      fingerprint: ["worker_error", message],
    });
  };

  log.warn = (message, fields) => {
    writeWarn(message, fields);
    const runIds = (fields as { runIds?: unknown } | undefined)?.runIds;
    if (!Array.isArray(runIds)) return;
    // The sweeper (heartbeat.ts) found runs whose worker stopped beating.
    const failed = message === "failed stalled runs";
    const resumed = message === "requeued stalled pushes";
    if (!failed && !resumed) return;
    for (const runId of runIds) {
      if (typeof runId !== "string") continue;
      void (async () => {
        const householdId = await options.householdOf?.(runId).catch(() => null);
        reporter.captureEvent("run_stalled", {
          householdId,
          runId,
          level: failed ? "error" : "warning",
          tags: { reason: failed ? "swept_failed" : "swept_requeued" },
          extra: { stale_seconds: (fields as { staleSeconds?: unknown }).staleSeconds },
          fingerprint: ["run_stalled", runId],
        });
      })();
    }
  };
}
