import { RetailerRequestError } from "@mp/retailers";
import { MockRetailer } from "@mp/retailers/mock";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Logger,
  MAX_ATTEMPTS,
  POLL_INTERVAL_MS,
  processMessage,
  type QueueClient,
  type QueueMessage,
  runPoller,
  SHOPPING_RUN_QUEUE,
  sleep,
  VISIBILITY_TIMEOUT_S,
} from "./queue.ts";
import {
  createRunsTestDb,
  enqueue,
  type RunsTestDb,
  recorder,
  runRow,
  seedHousehold,
} from "./testing/fixtures.ts";
import { testWorker } from "./testing/worker.ts";

function fakeClient(overrides: Partial<QueueClient>): QueueClient {
  return {
    exists: async () => true,
    read: async () => [],
    delete: async () => true,
    archive: async () => true,
    setVisibility: async () => {},
    ...overrides,
  };
}

/** Stops the poller after `ticks` waits and records each requested interval. */
function stopAfter(ticks: number, controller: AbortController) {
  const waits: number[] = [];
  const wait = async (ms: number) => {
    waits.push(ms);
    if (waits.length >= ticks) controller.abort();
  };
  return { wait, waits };
}

const message: QueueMessage = {
  msgId: "1",
  readCount: 1,
  enqueuedAt: new Date("2026-10-29T00:00:00Z"),
  message: { run_id: "r1" },
};

describe("runPoller", () => {
  it("logs idle on every empty poll of the shopping_run queue, every 5 seconds, claiming for 15 minutes", async () => {
    const reads: Array<[string, number, number]> = [];
    const client = fakeClient({
      read: async (queue, vt, qty) => {
        reads.push([queue, vt, qty]);
        return [];
      },
    });
    const log = recorder();
    const controller = new AbortController();
    const { wait, waits } = stopAfter(3, controller);

    await runPoller({ client, log, signal: controller.signal, wait, concurrency: 2 });

    expect(log.entries.filter((e) => e.msg === "idle")).toHaveLength(3);
    expect(VISIBILITY_TIMEOUT_S).toBe(900);
    expect(reads).toEqual([
      [SHOPPING_RUN_QUEUE, 900, 2],
      [SHOPPING_RUN_QUEUE, 900, 2],
      [SHOPPING_RUN_QUEUE, 900, 2],
    ]);
    expect(waits).toEqual([POLL_INTERVAL_MS, POLL_INTERVAL_MS, POLL_INTERVAL_MS]);
  });

  it("stays idle while the queue does not exist, warns once, and picks it up once created", async () => {
    let created = false;
    let existsCalls = 0;
    const client = fakeClient({
      exists: async () => {
        existsCalls += 1;
        return created;
      },
    });
    const log = recorder();
    const controller = new AbortController();
    let ticks = 0;
    const wait = async () => {
      ticks += 1;
      if (ticks === 2) created = true;
      if (ticks === 4) controller.abort();
    };

    await runPoller({ client, log, signal: controller.signal, wait });

    expect(log.entries.filter((e) => e.level === "warn")).toHaveLength(1);
    expect(log.entries.filter((e) => e.msg === "idle")).toHaveLength(4);
    expect(log.entries.filter((e) => e.fields?.reason === "queue_missing")).toHaveLength(2);
    expect(existsCalls).toBe(3);
  });

  it("acks a handled message and does not log idle for that tick", async () => {
    const deleted: string[] = [];
    const client = fakeClient({
      read: async () => [message],
      delete: async (_q, id) => {
        deleted.push(id);
        return true;
      },
    });
    const log = recorder();
    const controller = new AbortController();
    const { wait } = stopAfter(1, controller);
    const handled: string[] = [];

    await runPoller({
      client,
      log,
      signal: controller.signal,
      wait,
      handle: async (m) => {
        handled.push(m.msgId);
        return "done";
      },
    });

    expect(handled).toEqual(["1"]);
    expect(deleted).toEqual(["1"]);
    expect(log.entries.some((e) => e.msg === "idle")).toBe(false);
  });

  it("logs a failed poll and keeps polling", async () => {
    let calls = 0;
    const client = fakeClient({
      read: async () => {
        calls += 1;
        if (calls === 1) throw new Error("connection reset");
        return [];
      },
    });
    const log = recorder();
    const controller = new AbortController();
    const { wait } = stopAfter(2, controller);

    await runPoller({ client, log, signal: controller.signal, wait });

    expect(log.entries[0]).toMatchObject({ level: "error", msg: "poll failed" });
    expect(log.entries[1]).toMatchObject({ level: "info", msg: "idle" });
  });

  it("does not poll when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = fakeClient({
      exists: async () => {
        throw new Error("should not be called");
      },
    });
    const log: Logger = recorder();
    await runPoller({ client, log, signal: controller.signal });
    expect((log as ReturnType<typeof recorder>).entries).toEqual([]);
  });

  it("retries a failed attempt after a backoff, and dead-letters the third", async () => {
    const visibility: number[] = [];
    const archived: string[] = [];
    const finals: boolean[] = [];
    const client = fakeClient({
      setVisibility: async (_q, _id, s) => {
        visibility.push(s);
      },
      archive: async (_q, id) => {
        archived.push(id);
        return true;
      },
    });
    const options = {
      client,
      log: recorder(),
      queue: SHOPPING_RUN_QUEUE,
      maxAttempts: MAX_ATTEMPTS,
      retryBackoffS: 30,
      signal: new AbortController().signal,
      handle: async () => {
        throw new Error("boom");
      },
      onFailure: async (_m: QueueMessage, _e: unknown, final: boolean) => {
        finals.push(final);
      },
    };
    for (const readCount of [1, 2, 3]) await processMessage({ ...message, readCount }, options);
    expect(finals).toEqual([false, false, true]);
    expect(visibility).toEqual([30, 60]);
    expect(archived).toEqual(["1"]);
  });
});

describe("sleep", () => {
  it("resolves early when the signal aborts", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = sleep(10_000, controller.signal);
    controller.abort();
    await pending;
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("the real queue (pgmq semantics on PGlite)", () => {
  let t: RunsTestDb;

  beforeAll(async () => {
    t = await createRunsTestDb();
    await seedHousehold(t);
  }, 120_000);

  afterAll(async () => {
    await t?.close();
  });

  it("two worker instances claiming the same message do not both process it", async () => {
    const runId = await enqueue(t);
    const a = testWorker(t);
    const b = testWorker(t);

    // pgmq hands the message to one reader; the other sees nothing while it is held.
    const [first] = await a.queue.read(SHOPPING_RUN_QUEUE, 900, 1);
    const second = await b.queue.read(SHOPPING_RUN_QUEUE, 900, 1);
    expect(first).toBeDefined();
    expect(second).toEqual([]);

    // Even with the same message in both hands (a duplicate delivery), only one claims the run.
    if (!first) return;
    const [outA, outB] = await Promise.all([
      a.runner.handle(first, new AbortController().signal),
      b.runner.handle(first, new AbortController().signal),
    ]);
    expect([outA, outB]).toEqual(["done", "done"]);
    const searchesA = a.mock.calls.filter((c) => c.operation === "searchProducts").length;
    const searchesB = b.mock.calls.filter((c) => c.operation === "searchProducts").length;
    expect([searchesA, searchesB].sort()).toEqual([0, 12]);
    expect((await runRow(t, runId)).status).toBe("needs_review");
    await a.queue.delete(SHOPPING_RUN_QUEUE, first.msgId);
    await t.exec(`update public.shopping_runs set status = 'cancelled' where id = '${runId}'`);
  });

  it("a message that fails three times lands in the dead-letter archive and the run is failed with the error", async () => {
    const runId = await enqueue(t);
    const broken = new MockRetailer({ seed: 1 });
    broken.setFailure("searchProducts", "network");
    const worker = testWorker(t, { mock: broken });
    for (let attempt = 1; attempt <= 3; attempt++) {
      const [msg] = await worker.queue.read(SHOPPING_RUN_QUEUE, 900, 1);
      expect(msg?.readCount).toBe(attempt);
      if (!msg) return;
      await processMessage(msg, {
        client: worker.queue,
        log: worker.log,
        queue: SHOPPING_RUN_QUEUE,
        maxAttempts: MAX_ATTEMPTS,
        retryBackoffS: 0,
        signal: new AbortController().signal,
        handle: worker.runner.handle,
        onFailure: worker.runner.onFailure,
      });
      if (attempt < 3) expect((await runRow(t, runId)).status).toBe("queued");
    }
    const run = await runRow(t, runId);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/failed after 3 attempts: http_503/);
    const live = await t.query(
      `select count(*)::int as n from pgmq.q_shopping_run where message ->> 'run_id' = $1`,
      [runId],
    );
    const archive = await t.query(
      `select count(*)::int as n from pgmq.a_shopping_run where message ->> 'run_id' = $1`,
      [runId],
    );
    expect(live[0]).toEqual({ n: 0 });
    expect(archive[0]).toEqual({ n: 1 });
    expect(RetailerRequestError).toBeDefined();
  });
});
