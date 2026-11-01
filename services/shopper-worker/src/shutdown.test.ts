import { MockRetailer } from "@mp/retailers/mock";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runPoller, SHOPPING_RUN_QUEUE } from "./queue.ts";
import { handBack, installShutdown } from "./shutdown.ts";
import { RunStore } from "./store.ts";
import {
  createRunsTestDb,
  enqueue,
  type RunsTestDb,
  recorder,
  runRow,
  seedHousehold,
} from "./testing/fixtures.ts";
import { testWorker } from "./testing/worker.ts";

let t: RunsTestDb;

beforeAll(async () => {
  t = await createRunsTestDb();
  await seedHousehold(t);
}, 120_000);

afterAll(async () => {
  await t?.close();
});

describe("shutdown", () => {
  it("on SIGTERM an in-flight run goes back to queued and its message is visible again, well inside 10 seconds", async () => {
    const runId = await enqueue(t);
    // A slow store, so the run is mid-planning when the signal arrives.
    const worker = testWorker(t, { mock: new MockRetailer({ seed: 1, latencyMs: 40 }) });
    const controller = new AbortController();
    const listeners = new Map<string, () => void>();
    const shutdown = installShutdown({
      controller,
      log: worker.log,
      target: { once: (event, listener) => listeners.set(event, listener) },
      exit: () => {},
    });

    const started = Date.now();
    const polling = runPoller({
      client: worker.queue,
      log: worker.log,
      signal: controller.signal,
      intervalMs: 20,
      handle: worker.runner.handle,
      onFailure: worker.runner.onFailure,
      drainTimeoutMs: 5_000,
    });
    // Wait until the run is being planned, then send SIGTERM.
    for (let i = 0; i < 100 && worker.mock.calls.length < 2; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect((await runRow(t, runId)).status).toBe("running");
    listeners.get("SIGTERM")?.();
    expect(await shutdown).toBe("SIGTERM");
    const { abandoned } = await polling;
    expect(abandoned).toEqual([]);
    expect(Date.now() - started).toBeLessThan(10_000);

    const run = await runRow(t, runId);
    expect(run.status).toBe("queued");
    expect(run.heartbeat_at).toBeNull();
    const visible = await worker.queue.read(SHOPPING_RUN_QUEUE, 900, 1);
    expect(visible.map((m) => (m.message as { run_id: string }).run_id)).toEqual([runId]);
    expect(worker.log.entries.some((e) => e.msg === "run handed back")).toBe(true);
    // The next worker finishes the run from the start of its phase.
    const next = testWorker(t);
    const msg = visible[0];
    if (!msg) throw new Error("no message");
    await next.runner.handle(msg, new AbortController().signal);
    expect((await runRow(t, runId)).status).toBe("needs_review");
  });

  it("hands back runs whose handlers did not finish by the deadline", async () => {
    await t.exec(
      `update public.shopping_runs set status = 'cancelled' where status in ('queued', 'running', 'needs_review')`,
    );
    await t.exec("delete from pgmq.q_shopping_run");
    const runId = await enqueue(t);
    const store = new RunStore(t.runner);
    const worker = testWorker(t);
    const [message] = await worker.queue.read(SHOPPING_RUN_QUEUE, 900, 1);
    await store.claim(runId);
    if (!message) throw new Error("no message");
    expect(await handBack([message], { store, queue: worker.queue, log: recorder() })).toBe(1);
    expect((await runRow(t, runId)).status).toBe("queued");
    expect(await worker.queue.read(SHOPPING_RUN_QUEUE, 900, 1)).toHaveLength(1);
  });

  it("runs the forced hand-back at the deadline and exits", async () => {
    const listeners = new Map<string, () => void>();
    const exits: number[] = [];
    let forced = false;
    void installShutdown({
      controller: new AbortController(),
      log: recorder(),
      target: { once: (event, listener) => listeners.set(event, listener) },
      deadlineMs: 1_050,
      onDeadline: async () => {
        forced = true;
      },
      exit: (code) => void exits.push(code),
    });
    listeners.get("SIGINT")?.();
    await new Promise((r) => setTimeout(r, 200));
    expect(forced).toBe(true);
    expect(exits).toEqual([0]);
  });
});
