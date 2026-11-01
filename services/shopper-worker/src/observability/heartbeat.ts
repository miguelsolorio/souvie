// Run health from the outside (WS15, risk R10). WS09 built the heartbeat and the sweeper: a worker
// beats `shopping_runs.heartbeat_at` every 30 seconds, and any live worker fails or resumes a run
// whose heartbeat is older than 90 seconds. That covers a worker that dies while another is alive.
// It cannot cover the case where no worker is alive: nobody is left to sweep, and the run keeps
// saying "running" in the app.
//
// This watch is the alarm for that case. Every minute each worker looks for a run that is still
// running or checking_out ten minutes after its last heartbeat, and reports it to Sentry as a
// `run_stalled` event (reason no_worker), once per run per process. It also checks in to the
// Sentry Cron Monitor `shopper-worker`; when every worker is down, the missed check-ins raise the
// alert instead. The same query backs the `v_runs_stalled` view, for a dashboard.
//
// A run waiting on a person is `needs_review`, not running, so it is never stalled (R10).
import type { Logger } from "../queue.ts";
import { errorMessage } from "../queue.ts";
import type { RunStore } from "../store.ts";
import type { ErrorReporter } from "./sentry.ts";

/** No heartbeat for this long, on a run that says it is running: no worker is alive. */
export const STALL_ALERT_AFTER_SECONDS = 600;
export const STALL_WATCH_INTERVAL_MS = 60_000;

export interface StalledRun {
  runId: string;
  householdId: string;
  retailer: string;
  status: string;
  silentSeconds: number;
}

interface StalledRow {
  id: string;
  household_id: string;
  retailer: string;
  status: string;
  silent_seconds: number;
}

/**
 * Runs that are running or checking_out with no heartbeat for `afterSeconds`. A run still waiting
 * for a worker (running, heartbeat null) is measured from its last status change. The one query
 * across households, like the sweeper's, and it reads ids and a status only.
 */
export async function findStalledRuns(
  store: Pick<RunStore, "inServiceRole">,
  afterSeconds = STALL_ALERT_AFTER_SECONDS,
): Promise<StalledRun[]> {
  const rows = await store.inServiceRole((tx) =>
    tx.query<StalledRow>(
      `select r.id, r.household_id, r.retailer::text as retailer, r.status::text as status,
              floor(extract(epoch from (now() - coalesce(r.heartbeat_at, r.status_changed_at))))::integer
                as silent_seconds
         from public.shopping_runs r
        where r.status in ('running', 'checking_out')
          and coalesce(r.heartbeat_at, r.status_changed_at) < now() - make_interval(secs => $1::integer)
        order by silent_seconds desc
        limit 50`,
      [Math.ceil(afterSeconds)],
    ),
  );
  return rows.map((row) => ({
    runId: row.id,
    householdId: row.household_id,
    retailer: row.retailer,
    status: row.status,
    silentSeconds: row.silent_seconds,
  }));
}

export interface StallWatchOptions {
  store: Pick<RunStore, "inServiceRole">;
  reporter: ErrorReporter;
  log: Logger;
  afterSeconds?: number;
  intervalMs?: number;
}

export class StallWatch {
  readonly #o: StallWatchOptions;
  readonly #reported = new Set<string>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #running = false;

  constructor(options: StallWatchOptions) {
    this.#o = options;
  }

  /** One look. Returns the runs it reported this time. */
  async tick(): Promise<StalledRun[]> {
    if (this.#running) return [];
    this.#running = true;
    const { store, reporter, log } = this.#o;
    const fresh: StalledRun[] = [];
    try {
      const stalled = await findStalledRuns(store, this.#o.afterSeconds);
      const ids = new Set(stalled.map((run) => run.runId));
      // A run that was swept, finished, or beat again can stall again later and be reported again.
      for (const id of this.#reported) if (!ids.has(id)) this.#reported.delete(id);
      for (const run of stalled) {
        if (this.#reported.has(run.runId)) continue;
        this.#reported.add(run.runId);
        fresh.push(run);
        reporter.captureEvent("run_stalled", {
          householdId: run.householdId,
          runId: run.runId,
          level: "error",
          tags: { reason: "no_worker", retailer: run.retailer, status: run.status },
          extra: { silent_seconds: run.silentSeconds },
          fingerprint: ["run_stalled", run.runId],
        });
        log.warn("run stalled: no heartbeat, and no worker swept it", {
          runId: run.runId,
          status: run.status,
          silentSeconds: run.silentSeconds,
        });
      }
      reporter.checkIn("ok");
    } catch (error) {
      reporter.checkIn("error");
      log.warn("stall watch failed", { error: errorMessage(error) });
    } finally {
      this.#running = false;
    }
    return fresh;
  }

  start(): void {
    if (this.#timer) return;
    void this.tick();
    this.#timer = setInterval(
      () => void this.tick(),
      this.#o.intervalMs ?? STALL_WATCH_INTERVAL_MS,
    );
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
