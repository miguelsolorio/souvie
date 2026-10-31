// Run liveness (risk R10). While the worker holds a run it writes shopping_runs.heartbeat_at every
// WORKER_HEARTBEAT_SECONDS and pushes the queue message's visibility out, so no other worker takes
// it. A sweeper on the same tick looks for runs whose heartbeat is older than STALE_AFTER_SECONDS:
// their worker died. An approved push is requeued and resumes from the ledger; anything else is
// failed, so the app never shows "Shopping..." forever (store.ts sweepStale).
//
// Every worker sweeps every other worker's runs, so the threshold is one constant, never a
// worker's own setting: a worker with a short interval must not fail the runs of a worker with a
// long one. The interval is capped so three beats always fit inside the threshold.
import type { Logger, QueueClient } from "./queue.ts";
import { errorMessage, SHOPPING_RUN_QUEUE, VISIBILITY_TIMEOUT_S } from "./queue.ts";
import type { RunStore, SweepResult } from "./store.ts";

/** A heartbeat older than this means the worker is gone. The same for every worker. */
export const STALE_AFTER_SECONDS = 90;
/** Beats a live worker gets inside the threshold, at the longest interval. */
export const STALE_INTERVALS = 3;
/** The longest WORKER_HEARTBEAT_SECONDS: three beats fit inside STALE_AFTER_SECONDS. */
export const MAX_HEARTBEAT_SECONDS = STALE_AFTER_SECONDS / STALE_INTERVALS;
export const MIN_HEARTBEAT_SECONDS = 5;
export const DEFAULT_HEARTBEAT_SECONDS = 30;

export interface HeartbeatOptions {
  store: Pick<RunStore, "heartbeat" | "sweepStale">;
  queue: Pick<QueueClient, "setVisibility">;
  log: Logger;
  intervalSeconds?: number;
  queueName?: string;
  visibilityTimeoutS?: number;
}

export class Heartbeat {
  readonly intervalSeconds: number;
  readonly #options: HeartbeatOptions;
  readonly #held = new Map<string, string>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #ticking = false;

  constructor(options: HeartbeatOptions) {
    this.#options = options;
    const interval = options.intervalSeconds ?? DEFAULT_HEARTBEAT_SECONDS;
    if (interval > MAX_HEARTBEAT_SECONDS) {
      throw new Error(
        `a heartbeat every ${interval}s would let other workers sweep this worker's runs; the most is ${MAX_HEARTBEAT_SECONDS}s`,
      );
    }
    this.intervalSeconds = interval;
  }

  /** Seconds after which a run's heartbeat counts as stale: STALE_AFTER_SECONDS, for every worker. */
  get staleSeconds(): number {
    return STALE_AFTER_SECONDS;
  }

  hold(runId: string, msgId: string): void {
    this.#held.set(runId, msgId);
  }

  release(runId: string): void {
    this.#held.delete(runId);
  }

  held(): string[] {
    return [...this.#held.keys()];
  }

  /** One beat: every held run's heartbeat_at, and every held message's visibility. */
  async beat(): Promise<number> {
    const runIds = this.held();
    if (runIds.length === 0) return 0;
    const beaten = await this.#options.store.heartbeat(runIds);
    const queue = this.#options.queueName ?? SHOPPING_RUN_QUEUE;
    const vt = this.#options.visibilityTimeoutS ?? VISIBILITY_TIMEOUT_S;
    for (const msgId of this.#held.values()) {
      await this.#options.queue.setVisibility(queue, msgId, vt);
    }
    return beaten;
  }

  /** Resumes or fails runs nobody is beating for. */
  async sweep(): Promise<SweepResult> {
    const result = await this.#options.store.sweepStale(this.staleSeconds);
    if (result.requeued.length > 0) {
      this.#options.log.warn("requeued stalled pushes", {
        runIds: result.requeued,
        staleSeconds: this.staleSeconds,
      });
    }
    if (result.failed.length > 0) {
      this.#options.log.warn("failed stalled runs", {
        runIds: result.failed,
        staleSeconds: this.staleSeconds,
      });
    }
    return result;
  }

  /** One tick: beat first, so this worker's own runs are fresh before the sweep looks. */
  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      await this.beat();
      await this.sweep();
    } catch (error) {
      this.#options.log.error("heartbeat failed", { error: errorMessage(error) });
    } finally {
      this.#ticking = false;
    }
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.tick(), this.intervalSeconds * 1000);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
