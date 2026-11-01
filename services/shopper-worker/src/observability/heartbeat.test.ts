// Risk R10, the part the sweeper cannot cover: no worker alive. A run still "running" ten minutes
// after its last heartbeat is reported to Sentry as run_stalled, once, and the worker checks in to
// the Cron Monitor so that a dead fleet raises the alert instead.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RunStore } from "../store.ts";
import {
  CONNECTION,
  createRunsTestDb,
  HOUSEHOLD,
  LIST,
  type RunsTestDb,
  recorder,
  seedHousehold,
} from "../testing/fixtures.ts";
import { findStalledRuns, STALL_ALERT_AFTER_SECONDS, StallWatch } from "./heartbeat.ts";
import type { ErrorReporter, EventContext } from "./sentry.ts";

let t: RunsTestDb;
let store: RunStore;

beforeAll(async () => {
  t = await createRunsTestDb({ extraMigrations: ["ws15_observability"] });
  await seedHousehold(t);
  store = new RunStore(t.runner);
}, 120_000);

afterAll(async () => {
  await t?.close();
});

beforeEach(async () => {
  await t.exec(
    `update public.shopping_runs set status = 'cancelled' where status in ('queued', 'running', 'needs_review', 'cart_ready', 'checking_out');
     delete from pgmq.q_shopping_run;`,
  );
});

/** A run in `status` whose last heartbeat was `minutes` ago (null: it never had one). */
async function runAt(status: "running" | "checking_out" | "needs_review", minutes: number | null) {
  // Inserted directly: enqueue_shopping_run allows one active run per list.
  const rows = await t.query<{ id: string }>(
    `insert into public.shopping_runs (household_id, list_id, connection_id, retailer, status, heartbeat_at, status_changed_at)
     values ($1, $2, $3, 'kroger', $4::public.shopping_runs_status,
             case when $5::integer is null then null else now() - make_interval(mins => $5::integer) end, now())
     returning id`,
    [HOUSEHOLD, LIST, CONNECTION, status, minutes],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("no run inserted");
  // The status guard stamps status_changed_at on insert; a run that never beat is old by its status.
  if (minutes === null || status === "needs_review") {
    await t.query(
      `update public.shopping_runs set status_changed_at = now() - interval '15 minutes' where id = $1`,
      [id],
    );
  }
  return id;
}

function fakeReporter() {
  const events: Array<{ name: string; context: EventContext | undefined }> = [];
  const checkIns: string[] = [];
  const reporter: ErrorReporter = {
    enabled: true,
    captureException() {},
    captureEvent: (name, context) => void events.push({ name, context }),
    checkIn: (status) => void checkIns.push(status),
    traceRun: (_n, _c, work) => work({ fail() {} }),
    async flush() {},
  };
  return { reporter, events, checkIns };
}

describe("findStalledRuns", () => {
  it("lists a run that is running or checking out with no heartbeat for ten minutes", async () => {
    const stalled = await runAt("running", 11);
    const checkingOut = await runAt("checking_out", 30);
    const waiting = await runAt("running", null);
    const alive = await runAt("running", 9);
    const review = await runAt("needs_review", 120);
    const found = await findStalledRuns(store);
    const ids = found.map((run) => run.runId).sort();
    expect(ids).toEqual([stalled, checkingOut, waiting].sort());
    expect(ids).not.toContain(alive);
    expect(ids).not.toContain(review);
    const first = found.find((run) => run.runId === stalled);
    expect(first).toMatchObject({ householdId: HOUSEHOLD, retailer: "kroger", status: "running" });
    expect(first?.silentSeconds).toBeGreaterThanOrEqual(660);
    expect(found.find((run) => run.runId === waiting)?.silentSeconds).toBeGreaterThanOrEqual(900);
  });

  it("agrees with the v_runs_stalled view the dashboard reads", async () => {
    await runAt("running", 11);
    await runAt("checking_out", 30);
    await runAt("running", null);
    await runAt("running", 9);
    const fromView = await t.query<{ run_id: string }>(
      `select run_id from public.v_runs_stalled order by run_id`,
    );
    const fromWatch = await findStalledRuns(store, 600);
    expect(fromWatch.map((run) => run.runId).sort()).toEqual(fromView.map((row) => row.run_id));
    expect(STALL_ALERT_AFTER_SECONDS).toBe(600);
  });

  it("honors a different threshold", async () => {
    await runAt("running", 3);
    expect(await findStalledRuns(store, 600)).toEqual([]);
    expect(await findStalledRuns(store, 120)).toHaveLength(1);
  });
});

describe("StallWatch", () => {
  it("reports a stalled run once, with the run id and household tag, and checks in", async () => {
    const runId = await runAt("running", 12);
    const { reporter, events, checkIns } = fakeReporter();
    const log = recorder();
    const watch = new StallWatch({ store, reporter, log });

    const first = await watch.tick();
    expect(first.map((run) => run.runId)).toEqual([runId]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      name: "run_stalled",
      context: {
        householdId: HOUSEHOLD,
        runId,
        level: "error",
        tags: { reason: "no_worker", retailer: "kroger", status: "running" },
        fingerprint: ["run_stalled", runId],
      },
    });
    expect(checkIns).toEqual(["ok"]);
    expect(log.entries.some((e) => e.level === "warn" && e.msg.startsWith("run stalled"))).toBe(
      true,
    );

    // The same run is not reported again.
    expect(await watch.tick()).toEqual([]);
    expect(events).toHaveLength(1);
    expect(checkIns).toEqual(["ok", "ok"]);
  });

  it("reports a run again if it recovers and stalls a second time", async () => {
    const runId = await runAt("running", 12);
    const { reporter, events } = fakeReporter();
    const watch = new StallWatch({ store, reporter, log: recorder() });
    await watch.tick();
    // A worker took it back: a fresh heartbeat.
    await t.query(`update public.shopping_runs set heartbeat_at = now() where id = $1`, [runId]);
    expect(await watch.tick()).toEqual([]);
    await t.query(
      `update public.shopping_runs set heartbeat_at = now() - interval '20 minutes' where id = $1`,
      [runId],
    );
    expect((await watch.tick()).map((run) => run.runId)).toEqual([runId]);
    expect(events).toHaveLength(2);
  });

  it("checks in as an error, and keeps going, when the look fails", async () => {
    const { reporter, checkIns } = fakeReporter();
    const log = recorder();
    const broken = {
      inServiceRole: async () => {
        throw new Error("connection reset");
      },
    };
    const watch = new StallWatch({ store: broken as never, reporter, log });
    expect(await watch.tick()).toEqual([]);
    expect(checkIns).toEqual(["error"]);
    expect(log.entries.some((e) => e.msg === "stall watch failed")).toBe(true);
  });

  it("looks on a timer after start, and stops", async () => {
    vi.useFakeTimers();
    try {
      const { reporter, checkIns } = fakeReporter();
      const find = vi.fn(async () => []);
      const watch = new StallWatch({
        store: { inServiceRole: find } as never,
        reporter,
        log: recorder(),
        intervalMs: 1000,
      });
      watch.start();
      await vi.advanceTimersByTimeAsync(3100);
      watch.stop();
      const looks = find.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(find.mock.calls.length).toBe(looks);
      expect(looks).toBeGreaterThanOrEqual(3);
      expect(checkIns.every((s) => s === "ok")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
