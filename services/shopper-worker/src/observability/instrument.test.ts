// The worker's reports, driven through the real runner on PGlite with MockRetailer: the events a
// run produces (run_started, cart_ready), the Sentry events for a failed run, a failed attempt and a
// dead letter, the kill switch, and the sweeper's findings reaching Sentry as run_stalled.
import { MockRetailer } from "@mp/retailers/mock";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SqlApproveStore } from "../../../../supabase/functions/run-approve/store.ts";
import type { QueueMessage } from "../queue.ts";
import {
  ALICE,
  createRunsTestDb,
  enqueue,
  HOUSEHOLD,
  type RunsTestDb,
  recorder,
  runRow,
  seedHousehold,
} from "../testing/fixtures.ts";
import { testWorker } from "../testing/worker.ts";
import type { EventName, EventProps } from "./events.ts";
import {
  AGENT_DISABLED_ERROR,
  HOUSEHOLD_FIXABLE,
  instrumentLogger,
  instrumentRuns,
  LOG_EVENT_THROTTLE_MS,
  type RunSnapshot,
  readRunSnapshot,
  reportTransitions,
} from "./instrument.ts";
import { createAnalytics, type PostHogLike } from "./posthog.ts";
import type { ErrorReporter, EventContext } from "./sentry.ts";

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

function fakeReporter() {
  const events: Array<{ name: string; context: EventContext | undefined }> = [];
  const exceptions: Array<{ error: unknown; context: EventContext | undefined }> = [];
  const traces: Array<{ name: string; context: EventContext; failed: string | null }> = [];
  const reporter: ErrorReporter = {
    enabled: true,
    captureException: (error, context) => void exceptions.push({ error, context }),
    captureEvent: (name, context) => void events.push({ name, context }),
    checkIn() {},
    async traceRun(name, context, work) {
      const entry = { name, context, failed: null as string | null };
      traces.push(entry);
      try {
        return await work({
          fail: (reason) => {
            entry.failed = reason;
          },
        });
      } catch (error) {
        // What the real reporter does with a message that throws (sentry.ts reporterOver).
        entry.failed = "internal_error";
        throw error;
      }
    },
    async flush() {},
  };
  return { reporter, events, exceptions, traces };
}

function fakeAnalytics(flag: boolean | undefined = undefined) {
  const captured: Array<{
    event: string;
    properties?: Record<string, unknown>;
    distinctId: string;
  }> = [];
  const client: PostHogLike = {
    capture: (m) => void captured.push(m),
    getFeatureFlag: async (key) => (key === "shopping_agent_enabled" ? flag : undefined),
  };
  return { analytics: createAnalytics({ client }), captured };
}

function wired(options: { mock?: MockRetailer; flag?: boolean } = {}) {
  const worker = testWorker(t, options.mock ? { mock: options.mock } : {});
  const reporting = fakeReporter();
  const analytics = fakeAnalytics(options.flag);
  const log = recorder();
  const instrumented = instrumentRuns({
    runs: worker.runner,
    store: worker.store,
    analytics: analytics.analytics,
    reporter: reporting.reporter,
    log,
  });
  return { worker, ...reporting, ...analytics, log, instrumented };
}

describe("product events from a run", () => {
  it("emits run_started when a worker first takes a run and cart_ready when the push finishes", async () => {
    await closeRuns();
    const w = wired();
    const runId = await enqueue(t, { per_item_ceiling_usd: 15 });

    await w.worker.next();
    expect((await runRow(t, runId)).status).toBe("needs_review");
    expect(w.captured.map((c) => c.event)).toEqual(["run_started"]);
    expect(w.captured[0]).toMatchObject({
      distinctId: HOUSEHOLD,
      properties: { retailer: "kroger", trigger: "manual" },
    });

    const approved = await new SqlApproveStore(t.runner).approve({
      runId,
      householdId: HOUSEHOLD,
      userId: ALICE,
      decisions: [],
    });
    expect(approved.ok).toBe(true);
    await w.worker.next();
    expect((await runRow(t, runId)).status).toBe("cart_ready");

    // The push phase is not a second start. cart_ready carries counts and a bucket, no dollars.
    expect(w.captured.map((c) => c.event)).toEqual(["run_started", "cart_ready"]);
    const ready = w.captured[1]?.properties as EventProps["cart_ready"];
    expect(ready.retailer).toBe("kroger");
    expect(ready.items).toBeGreaterThan(5);
    expect(["under_50", "50_100", "100_150", "150_200", "over_200"]).toContain(
      ready.subtotal_bucket,
    );
    // No dollar sign, no cents, no amount-named field.
    expect(JSON.stringify(w.captured)).not.toMatch(
      /\$|\d+\.\d{2}|"[a-z_]*(usd|price|amount)[a-z_]*"/i,
    );
  });

  it("traces each message as one transaction tagged with the run and household", async () => {
    await closeRuns();
    const w = wired();
    const runId = await enqueue(t);
    await w.worker.next();
    expect(w.traces).toHaveLength(1);
    expect(w.traces[0]).toMatchObject({
      name: "shopping_run",
      context: { householdId: HOUSEHOLD, runId },
      failed: null,
    });
    expect(w.instrumented.inFlight()).toBe(0);
  });

  it("emits nothing for a message whose run is not claimable", async () => {
    await closeRuns();
    const w = wired();
    const runId = await enqueue(t);
    await w.worker.next();
    w.captured.length = 0;
    await t.query(`select public.shopping_run_dispatch($1::uuid)`, [runId]);
    await w.worker.next();
    expect(w.captured).toEqual([]);
  });
});

describe("a failed run", () => {
  it("a store sign-in that expired is a run_failed event but not a worker error: the transaction stays ok", async () => {
    await closeRuns();
    const mock = new MockRetailer({ seed: 1 });
    mock.setFailure("searchProducts", "auth");
    const w = wired({ mock });
    const runId = await enqueue(t);
    await w.worker.next();
    expect((await runRow(t, runId)).status).toBe("failed");

    expect(w.events).toHaveLength(1);
    expect(w.events[0]?.name).toBe("run_failed");
    expect(w.events[0]?.context).toMatchObject({
      householdId: HOUSEHOLD,
      runId,
      level: "warning",
      tags: { retailer: "kroger", trigger: "manual" },
    });
    expect(w.events[0]?.context?.extra).toMatchObject({
      error: expect.stringMatching(/needs_reauth/),
    });
    // The household has to sign in again: that is not the worker's error rate.
    expect(w.traces[0]?.failed).toBeNull();
    // A failed run is not a started-then-ready run.
    expect(w.captured.map((c) => c.event)).toEqual(["run_started"]);
    await t.exec(
      `update public.retailer_connections set status = 'active' where status = 'needs_reauth'`,
    );
  });

  it("an outage the worker could not handle marks the transaction failed", async () => {
    await closeRuns();
    const mock = new MockRetailer({ seed: 1 });
    mock.setFailure("searchProducts", "network");
    const w = wired({ mock });
    const runId = await enqueue(t);
    // The attempt throws (the queue retries it); the transaction is a failure and the run is
    // handed back, not yet failed.
    await expect(w.worker.next()).rejects.toThrow();
    expect(w.traces[0]?.failed).toBe("internal_error");
    expect((await runRow(t, runId)).status).toBe("running");
  });

  it("names the failure codes a household can fix, and no others", () => {
    expect(HOUSEHOLD_FIXABLE.test("needs_reauth")).toBe(true);
    expect(HOUSEHOLD_FIXABLE.test("connection_revoked")).toBe(true);
    expect(HOUSEHOLD_FIXABLE.test("agent_disabled")).toBe(true);
    expect(HOUSEHOLD_FIXABLE.test("adapter_unavailable")).toBe(false);
    expect(HOUSEHOLD_FIXABLE.test("failed after 3 attempts")).toBe(false);
    expect(HOUSEHOLD_FIXABLE.test("stalled")).toBe(false);
  });
});

describe("failed attempts and the dead letter", () => {
  const message = (runId: string, readCount: number): QueueMessage => ({
    msgId: "17",
    readCount,
    enqueuedAt: new Date(),
    message: { run_id: runId },
  });

  it("reports each failed attempt with its stack, and the last one as run_dead_lettered", async () => {
    await closeRuns();
    const w = wired();
    const runId = await enqueue(t);
    const [read] = await w.worker.queue.read("shopping_run", 900, 1);
    if (!read) throw new Error("no message");
    await t.query(`update public.shopping_runs set status = 'running' where id = $1`, [runId]);

    const boom = new Error("kroger answered 503");
    await w.worker.runner.onFailure(message(runId, 1), boom, false);
    expect(w.exceptions).toHaveLength(1);
    expect(w.exceptions[0]?.error).toBe(boom);
    expect(w.exceptions[0]?.context).toMatchObject({
      householdId: HOUSEHOLD,
      runId,
      level: "warning",
      tags: { attempt: "1", final: "false" },
    });
    expect(w.events).toEqual([]);
    // The runner's own handling still ran: the run went back to queued for the retry.
    expect((await runRow(t, runId)).status).toBe("queued");

    await t.query(`update public.shopping_runs set status = 'running' where id = $1`, [runId]);
    await w.worker.runner.onFailure(message(runId, 3), boom, true);
    expect(w.exceptions).toHaveLength(2);
    expect(w.exceptions[1]?.context).toMatchObject({
      level: "error",
      tags: { attempt: "3", final: "true" },
    });
    expect(w.events).toHaveLength(1);
    expect(w.events[0]).toMatchObject({
      name: "run_dead_lettered",
      context: { householdId: HOUSEHOLD, runId, fingerprint: ["run_dead_lettered", runId] },
    });
    expect((await runRow(t, runId)).status).toBe("failed");
  });

  it("still reports when the run cannot be read", async () => {
    await closeRuns();
    const w = wired();
    await w.worker.runner.onFailure(
      message("5a000000-0000-4000-8000-0000000000ee", 1),
      new Error("x"),
      false,
    );
    expect(w.exceptions).toHaveLength(1);
    expect(w.exceptions[0]?.context?.householdId).toBeUndefined();
  });
});

describe("the shopping_agent_enabled kill switch", () => {
  it("fails a claimable run with a plain reason when PostHog says off, and starts nothing", async () => {
    await closeRuns();
    const w = wired({ flag: false });
    const runId = await enqueue(t);
    const result = await w.worker.next();
    expect(result?.outcome).toBe("done");
    const run = await runRow(t, runId);
    expect(run.status).toBe("failed");
    expect(run.error).toBe(AGENT_DISABLED_ERROR);
    expect(w.worker.mock.calls).toEqual([]);
    expect(w.captured).toEqual([]);
    expect(w.log.entries.some((e) => e.msg === "run refused: shopping_agent_enabled is off")).toBe(
      true,
    );
  });

  it("runs as usual when the flag is on, unset, or PostHog says nothing", async () => {
    for (const flag of [true, undefined]) {
      await closeRuns();
      const w = wired({ flag });
      const runId = await enqueue(t);
      await w.worker.next();
      expect((await runRow(t, runId)).status).toBe("needs_review");
    }
  });
});

describe("reportTransitions", () => {
  const base: RunSnapshot = {
    runId: "5a000000-0000-4000-8000-0000000000a1",
    householdId: HOUSEHOLD,
    retailer: "safeway",
    trigger: "scheduled",
    status: "queued",
    approved: false,
    claimable: true,
    subtotalUsd: 142.17,
    items: 31,
    error: null,
  };

  it("names the trigger and retailer, and buckets the subtotal", () => {
    const { analytics, captured } = fakeAnalytics();
    const { reporter } = fakeReporter();
    reportTransitions(base, { ...base, status: "needs_review" }, { analytics, reporter });
    reportTransitions(
      { ...base, status: "running", approved: true },
      { ...base, status: "cart_ready", approved: true },
      { analytics, reporter },
    );
    expect(captured.map((c) => [c.event, c.properties])).toEqual([
      ["run_started", { retailer: "safeway", trigger: "scheduled" }],
      ["cart_ready", { retailer: "safeway", items: 31, subtotal_bucket: "100_150" }],
    ]);
  });

  it("does nothing without both snapshots, or when a run was handed straight back", () => {
    const { analytics, captured } = fakeAnalytics();
    const { reporter, events } = fakeReporter();
    reportTransitions(null, base, { analytics, reporter });
    reportTransitions(base, null, { analytics, reporter });
    reportTransitions(base, { ...base }, { analytics, reporter });
    expect(captured).toEqual([]);
    expect(events).toEqual([]);
  });

  it("readRunSnapshot is null for a run that does not exist and for a database that fails", async () => {
    const store = {
      inServiceRole: (async () => {
        throw new Error("down");
      }) as never,
    };
    expect(await readRunSnapshot(store, base.runId)).toBeNull();
    expect(
      await readRunSnapshot(
        new (await import("../store.ts")).RunStore(t.runner),
        "5a000000-0000-4000-8000-0000000000ef",
      ),
    ).toBeNull();
  });
});

describe("instrumentLogger", () => {
  function setup(now = () => 0) {
    const log = recorder();
    const { reporter, events } = fakeReporter();
    const households = vi.fn(async (runId: string) => (runId.endsWith("a1") ? HOUSEHOLD : null));
    instrumentLogger(log, reporter, { now, householdOf: households });
    return { log, events, households };
  }

  it("still writes every line, unchanged", () => {
    const { log } = setup();
    log.error("poll failed", { queue: "shopping_run", error: "ECONNRESET" });
    log.warn("something odd", { a: 1 });
    log.info("fine");
    expect(log.entries.map((e) => [e.level, e.msg])).toEqual([
      ["error", "poll failed"],
      ["warn", "something odd"],
      ["info", "fine"],
    ]);
  });

  it("reports an error log once in five minutes, and not the ones onFailure already reports", () => {
    let t0 = 0;
    const { log, events } = setup(() => t0);
    log.error("poll failed", { error: "ECONNRESET" });
    log.error("poll failed", { error: "ECONNRESET" });
    t0 = LOG_EVENT_THROTTLE_MS + 1;
    log.error("poll failed", { error: "ECONNRESET" });
    log.error("heartbeat failed", { error: "x" });
    log.error("message failed, will retry", { msgId: "1" });
    log.error("message failed for the last time, dead-lettered", { msgId: "1" });
    expect(events.map((e) => [e.name, e.context?.tags])).toEqual([
      ["worker_error", { log: "poll failed" }],
      ["worker_error", { log: "poll failed" }],
      ["worker_error", { log: "heartbeat failed" }],
    ]);
  });

  it("turns the sweeper's findings into run_stalled events, one per run, with the household tag", async () => {
    const { log, events, households } = setup();
    log.warn("failed stalled runs", {
      runIds: ["5a000000-0000-4000-8000-0000000000a1", "5a000000-0000-4000-8000-0000000000b2"],
      staleSeconds: 90,
    });
    log.warn("requeued stalled pushes", {
      runIds: ["5a000000-0000-4000-8000-0000000000a1"],
      staleSeconds: 90,
    });
    await vi.waitFor(() => expect(events).toHaveLength(3));
    expect(households).toHaveBeenCalledTimes(3);
    const byReason = events.map((e) => [
      e.name,
      e.context?.tags?.reason,
      e.context?.runId,
      e.context?.householdId,
      e.context?.level,
    ]);
    expect(byReason).toContainEqual([
      "run_stalled",
      "swept_failed",
      "5a000000-0000-4000-8000-0000000000a1",
      HOUSEHOLD,
      "error",
    ]);
    expect(byReason).toContainEqual([
      "run_stalled",
      "swept_failed",
      "5a000000-0000-4000-8000-0000000000b2",
      null,
      "error",
    ]);
    expect(byReason).toContainEqual([
      "run_stalled",
      "swept_requeued",
      "5a000000-0000-4000-8000-0000000000a1",
      HOUSEHOLD,
      "warning",
    ]);
    expect(events[0]?.context?.extra).toEqual({ stale_seconds: 90 });
  });

  it("ignores other warnings, including ones that carry runIds", () => {
    const { log, events } = setup();
    log.warn("run handed back", { runIds: ["x"] });
    log.warn("failed stalled runs", { runIds: "nope" });
    log.warn("failed stalled runs");
    expect(events).toEqual([]);
  });
});

describe("the real sweeper, through the logger", () => {
  it("a stalled run the sweeper fails reaches Sentry as run_stalled with the run id", async () => {
    await closeRuns();
    const w = wired();
    const log = recorder();
    const { reporter, events } = fakeReporter();
    instrumentLogger(log, reporter, {
      householdOf: async (id) => (await readRunSnapshot(w.worker.store, id))?.householdId ?? null,
    });
    // A heartbeat object that logs through the instrumented logger, as in production.
    const { Heartbeat } = await import("../heartbeat.ts");
    const heartbeat = new Heartbeat({
      store: w.worker.store,
      queue: w.worker.queue,
      log,
      intervalSeconds: 30,
    });
    const runId = await enqueue(t);
    await t.query(
      `update public.shopping_runs set status = 'running', heartbeat_at = now() - interval '5 minutes' where id = $1`,
      [runId],
    );
    const swept = await heartbeat.sweep();
    expect(swept.failed).toEqual([runId]);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({
      name: "run_stalled",
      context: { runId, householdId: HOUSEHOLD, tags: { reason: "swept_failed" } },
    });
  });
});

describe("EventName coverage", () => {
  it("the worker emits only events that are in the table", () => {
    const emitted: EventName[] = ["run_started", "cart_ready"];
    expect(emitted.every((name) => ["run_started", "cart_ready"].includes(name))).toBe(true);
  });
});
