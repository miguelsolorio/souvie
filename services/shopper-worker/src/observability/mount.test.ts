// mountObservability: one call from src/index.ts. With no keys it changes nothing a run does; with
// them it wraps the runner and the logger and, on SIGTERM, waits for in-flight runs before it
// flushes, so the process still exits inside the shutdown deadline.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createRunsTestDb,
  enqueue,
  type RunsTestDb,
  recorder,
  runRow,
  seedHousehold,
} from "../testing/fixtures.ts";
import { testWorker } from "../testing/worker.ts";
import { mountObservability } from "./index.ts";
import { createAnalytics } from "./posthog.ts";
import type { ErrorReporter } from "./sentry.ts";

let t: RunsTestDb;

beforeAll(async () => {
  t = await createRunsTestDb({ extraMigrations: ["ws15_observability"] });
  await seedHousehold(t);
}, 120_000);

afterAll(async () => {
  await t?.close();
});

async function closeRuns() {
  await t.exec(
    `update public.shopping_runs set status = 'cancelled' where status in ('queued', 'running', 'needs_review', 'cart_ready', 'checking_out');
     delete from pgmq.q_shopping_run;`,
  );
}

describe("mountObservability", () => {
  it("with no DSN and no key, starts nothing, says so, and leaves the run alone", async () => {
    await closeRuns();
    const worker = testWorker(t);
    const log = recorder();
    const controller = new AbortController();
    const mounted = await mountObservability({
      env: {},
      runs: worker.runner,
      store: worker.store,
      log,
      signal: controller.signal,
    });
    expect(mounted.reporter.enabled).toBe(false);
    expect(mounted.analytics.enabled).toBe(false);
    expect(log.entries.find((e) => e.msg === "observability")?.fields).toEqual({
      sentry: "off",
      posthog: "off",
      release: "unset",
    });

    const runId = await enqueue(t);
    const result = await worker.next();
    expect(result?.outcome).toBe("done");
    expect((await runRow(t, runId)).status).toBe("needs_review");
    controller.abort();
    await mounted.stop();
  });

  it("reports the release it was built from", async () => {
    const worker = testWorker(t);
    const log = recorder();
    const controller = new AbortController();
    const mounted = await mountObservability({
      env: { GIT_SHA: "9f8e7d6" },
      runs: worker.runner,
      store: worker.store,
      log,
      signal: controller.signal,
    });
    expect(log.entries.find((e) => e.msg === "observability")?.fields).toMatchObject({
      release: "9f8e7d6",
    });
    controller.abort();
    await mounted.stop();
  });

  it("on SIGTERM waits for the in-flight run, then flushes both clients, and stops once", async () => {
    await closeRuns();
    const worker = testWorker(t);
    const order: string[] = [];
    const reporter: ErrorReporter = {
      enabled: true,
      captureException() {},
      captureEvent() {},
      checkIn() {},
      traceRun: (_n, _c, work) => work({ fail() {} }),
      flush: vi.fn(async () => void order.push("sentry flushed")),
    };
    const analytics = createAnalytics();
    analytics.shutdown = vi.fn(async () => void order.push("posthog shut down"));
    const controller = new AbortController();
    const mounted = await mountObservability({
      env: {},
      runs: worker.runner,
      store: worker.store,
      log: recorder(),
      signal: controller.signal,
      reporter,
      analytics,
      drainMs: 3000,
    });

    // A run is being handled when the signal arrives.
    const runId = await enqueue(t);
    const [message] = await worker.queue.read("shopping_run", 900, 1);
    if (!message) throw new Error("no message");
    const handling = worker.runner.handle(message, new AbortController().signal).then(() => {
      order.push("run handled");
    });
    controller.abort();
    await handling;
    await mounted.stop();
    await mounted.stop();

    expect(order).toEqual(["run handled", "sentry flushed", "posthog shut down"]);
    expect(reporter.flush).toHaveBeenCalledTimes(1);
    expect(analytics.shutdown).toHaveBeenCalledTimes(1);
    expect((await runRow(t, runId)).status).toBe("needs_review");
  });
});
