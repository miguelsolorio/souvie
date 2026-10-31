// Run liveness (risk R10). While the worker holds a run it writes shopping_runs.heartbeat_at every
// WORKER_HEARTBEAT_SECONDS and pushes the queue message's visibility out, so no other worker takes
// it. A sweeper on the same tick fails any run whose heartbeat is older than three intervals: its
// worker died, and the app must not show "Shopping..." forever.
import type { Logger, QueueClient } from "./queue.ts";
import { errorMessage, SHOPPING_RUN_QUEUE, VISIBILITY_TIMEOUT_S } from "./queue.ts";
import type { RunStore } from "./store.ts";

export const DEFAULT_HEARTBEAT_SECONDS = 30;
/** A heartbeat older than this many intervals means the worker is gone. */
export const STALE_INTERVALS = 3;

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
    this.intervalSeconds = options.intervalSeconds ?? DEFAULT_HEARTBEAT_SECONDS;
  }

  /** Seconds after which another run's heartbeat counts as stale. */
  get staleSeconds(): number {
    return this.intervalSeconds * STALE_INTERVALS;
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

  /** Fails runs nobody is beating for. Returns their ids. */
  async sweep(): Promise<string[]> {
    const failed = await this.#options.store.sweepStale(this.staleSeconds);
    if (failed.length > 0) {
      this.#options.log.warn("failed stalled runs", {
        runIds: failed,
        staleSeconds: this.staleSeconds,
      });
    }
    return failed;
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
