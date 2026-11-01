// Observability for the worker (WS15), mounted with one call from src/index.ts:
//
//   await mountObservability({ env: process.env, runs, store: runStore, log, signal });
//
// It starts Sentry and PostHog from the environment (each is a no-op without its key), wraps the
// runner's `handle` and `onFailure` and the logger (instrument.ts), and starts the stall watch
// (heartbeat.ts). On SIGTERM it waits for the in-flight runs to hand back, then flushes both
// clients, so the process still exits inside the shutdown deadline.
import type { Logger } from "../queue.ts";
import type { RunRunner } from "../runner.ts";
import type { RunStore } from "../store.ts";
import { StallWatch } from "./heartbeat.ts";
import { instrumentLogger, instrumentRuns, readRunSnapshot } from "./instrument.ts";
import { type Analytics, createPostHogAnalytics, type PostHogEnv } from "./posthog.ts";
import { createSentryReporter, type ErrorReporter, releaseOf, type SentryEnv } from "./sentry.ts";

export interface MountOptions {
  env: SentryEnv & PostHogEnv;
  runs: Pick<RunRunner, "handle" | "onFailure">;
  store: Pick<RunStore, "inServiceRole" | "fail">;
  log: Logger;
  signal: AbortSignal;
  /** For tests: replace the clients. */
  reporter?: ErrorReporter;
  analytics?: Analytics;
  /** How long to wait for in-flight runs after the signal before flushing. Default 5000. */
  drainMs?: number;
}

export interface Observability {
  reporter: ErrorReporter;
  analytics: Analytics;
  watch: StallWatch;
  /** Stops the watch, waits for in-flight runs, flushes Sentry and PostHog. Safe to call twice. */
  stop(): Promise<void>;
}

export async function mountObservability(options: MountOptions): Promise<Observability> {
  const { env, runs, store, log, signal } = options;
  const warn = (message: string) => log.warn(message);
  const reporter = options.reporter ?? (await createSentryReporter(env, { onWarning: warn }));
  const analytics = options.analytics ?? (await createPostHogAnalytics(env, warn));

  instrumentLogger(log, reporter, {
    householdOf: async (runId) => (await readRunSnapshot(store, runId))?.householdId ?? null,
  });
  const runsState = instrumentRuns({ runs, store, analytics, reporter, log });
  const watch = new StallWatch({ store, reporter, log });
  watch.start();

  log.info("observability", {
    sentry: reporter.enabled ? "on" : "off",
    posthog: analytics.enabled ? "on" : "off",
    release: releaseOf(env) ?? "unset",
  });

  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      watch.stop();
      const deadline = Date.now() + (options.drainMs ?? 5000);
      while (runsState.inFlight() > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await Promise.all([reporter.flush(2000), analytics.shutdown(2000)]);
    })();
    return stopping;
  };
  signal.addEventListener("abort", () => void stop(), { once: true });
  process.once("beforeExit", () => void stop());

  return { reporter, analytics, watch, stop };
}
