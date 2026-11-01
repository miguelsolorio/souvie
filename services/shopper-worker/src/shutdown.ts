// Clean exit on SIGTERM (Fly.io and Railway send it before a deploy or a scale-down), with no run
// lost: the poller stops reading, in-flight runs stop at their next step and go back to queued,
// and their messages become visible at once so the next worker picks them up. Whatever has not
// stopped by the deadline is handed back by force, and the process exits within ten seconds.
import type { Logger, QueueClient, QueueMessage } from "./queue.ts";
import { errorMessage, SHOPPING_RUN_QUEUE } from "./queue.ts";
import { parseRunMessage } from "./runner.ts";
import type { RunStore } from "./store.ts";

/** The brief: exit within 10 seconds of SIGTERM. */
export const SHUTDOWN_DEADLINE_MS = 10_000;
/** How long the poller waits for handlers before the forced hand-back. */
export const DRAIN_TIMEOUT_MS = 7_000;

export interface ShutdownTarget {
  once(event: "SIGTERM" | "SIGINT", listener: () => void): unknown;
}

export interface ShutdownOptions {
  controller: AbortController;
  log: Logger;
  target?: ShutdownTarget;
  /** Runs at the deadline if the worker is still up, then the process exits. */
  onDeadline?: () => Promise<void>;
  exit?: (code: number) => void;
  deadlineMs?: number;
}

/** Wires SIGTERM and SIGINT. Resolves with the signal's name when one arrives. */
export function installShutdown(options: ShutdownOptions): Promise<string> {
  const target = options.target ?? process;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const deadlineMs = options.deadlineMs ?? SHUTDOWN_DEADLINE_MS;
  return new Promise((resolve) => {
    let started = false;
    for (const name of ["SIGINT", "SIGTERM"] as const) {
      target.once(name, () => {
        if (started) return;
        started = true;
        options.log.info("shutting down", { signal: name });
        options.controller.abort();
        resolve(name);
        const timer = setTimeout(
          () => {
            options.log.warn("shutdown deadline reached, handing back by force");
            void (options.onDeadline?.() ?? Promise.resolve()).finally(() => exit(0));
          },
          Math.max(0, deadlineMs - 1_000),
        );
        timer.unref?.();
      });
    }
  });
}

export interface HandBackOptions {
  store: Pick<RunStore, "requeueById">;
  queue: Pick<QueueClient, "setVisibility">;
  log: Logger;
  queueName?: string;
}

/** Puts runs whose handlers did not finish back to queued, and their messages back in view. */
export async function handBack(
  messages: readonly QueueMessage[],
  options: HandBackOptions,
): Promise<number> {
  let count = 0;
  for (const message of messages) {
    const runId = parseRunMessage(message.message);
    try {
      if (runId) await options.store.requeueById(runId);
      await options.queue.setVisibility(options.queueName ?? SHOPPING_RUN_QUEUE, message.msgId, 0);
      count += 1;
    } catch (error) {
      options.log.error("could not hand a run back", { runId, error: errorMessage(error) });
    }
  }
  if (count > 0) options.log.info("handed runs back", { count });
  return count;
}
