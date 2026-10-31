import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Heartbeat, MAX_HEARTBEAT_SECONDS, STALE_AFTER_SECONDS } from "./heartbeat.ts";
import { createPgmqClient, SHOPPING_RUN_QUEUE } from "./queue.ts";
import { RunStore } from "./store.ts";
import {
  createRunsTestDb,
  enqueue,
  type RunsTestDb,
  recorder,
  runRow,
  seedHousehold,
} from "./testing/fixtures.ts";

let t: RunsTestDb;

beforeAll(async () => {
  t = await createRunsTestDb();
  await seedHousehold(t);
}, 120_000);

afterAll(async () => {
  await t?.close();
});

async function claimed(): Promise<{ runId: string; msgId: string }> {
  await t.exec(
    `update public.shopping_runs set status = 'cancelled' where status in ('queued', 'running', 'needs_review')`,
  );
  const runId = await enqueue(t);
  const store = new RunStore(t.runner);
  const queue = createPgmqClient(t.runner);
  const [message] = await queue.read(SHOPPING_RUN_QUEUE, 900, 1);
  const run = await store.claim(runId);
  if (!message || !run) throw new Error("could not claim");
  return { runId, msgId: message.msgId };
}

describe("heartbeat", () => {
  it("writes heartbeat_at for every held run and keeps the message hidden", async () => {
    const { runId, msgId } = await claimed();
    await t.exec(
      `update public.shopping_runs set heartbeat_at = now() - interval '50 seconds' where id = '${runId}'`,
    );
    const queue = createPgmqClient(t.runner);
    const heartbeat = new Heartbeat({
      store: new RunStore(t.runner),
      queue,
      log: recorder(),
      intervalSeconds: 30,
    });
    heartbeat.hold(runId, msgId);
    const before = Date.parse((await runRow(t, runId)).heartbeat_at ?? "");
    expect(await heartbeat.beat()).toBe(1);
    const after = Date.parse((await runRow(t, runId)).heartbeat_at ?? "");
    expect(after - before).toBeGreaterThan(40_000);
    const vt = await t.query<{ seconds: number }>(
      `select extract(epoch from vt - clock_timestamp())::float8 as seconds from pgmq.q_shopping_run where msg_id = $1`,
      [msgId],
    );
    expect(vt[0]?.seconds).toBeGreaterThan(800);
    heartbeat.release(runId);
    expect(heartbeat.held()).toEqual([]);
  });

  it("the sweeper fails an unapproved run whose heartbeat is older than the threshold, and leaves a fresh one", async () => {
    const stale = await claimed();
    await t.exec(
      `update public.shopping_runs set heartbeat_at = now() - interval '91 seconds' where id = '${stale.runId}'`,
    );
    const log = recorder();
    const heartbeat = new Heartbeat({
      store: new RunStore(t.runner),
      queue: createPgmqClient(t.runner),
      log,
      intervalSeconds: 30,
    });
    expect(heartbeat.staleSeconds).toBe(STALE_AFTER_SECONDS);
    expect(await heartbeat.sweep()).toEqual({ requeued: [], failed: [stale.runId] });
    const run = await runRow(t, stale.runId);
    expect(run.status).toBe("failed");
    expect(run.error).toBe("stalled: no heartbeat for 90 seconds");
    expect(log.entries.some((e) => e.msg === "failed stalled runs")).toBe(true);

    const fresh = await claimed();
    await t.exec(
      `update public.shopping_runs set heartbeat_at = now() - interval '89 seconds' where id = '${fresh.runId}'`,
    );
    expect(await heartbeat.sweep()).toEqual({ requeued: [], failed: [] });
    expect((await runRow(t, fresh.runId)).status).toBe("running");
  });

  it("sweeps with one threshold for every worker, whatever its own interval", async () => {
    const run = await claimed();
    // A worker beating every 30 seconds was last seen 60 seconds ago: alive, two beats missed.
    await t.exec(
      `update public.shopping_runs set heartbeat_at = now() - interval '60 seconds' where id = '${run.runId}'`,
    );
    const quick = new Heartbeat({
      store: new RunStore(t.runner),
      queue: createPgmqClient(t.runner),
      log: recorder(),
      intervalSeconds: 5,
    });
    expect(quick.staleSeconds).toBe(STALE_AFTER_SECONDS);
    expect(await quick.sweep()).toEqual({ requeued: [], failed: [] });
    expect((await runRow(t, run.runId)).status).toBe("running");
    expect(
      () =>
        new Heartbeat({
          store: new RunStore(t.runner),
          queue: createPgmqClient(t.runner),
          log: recorder(),
          intervalSeconds: MAX_HEARTBEAT_SECONDS + 1,
        }),
    ).toThrow(/most is 30s/);
  });

  it("never sweeps a run that waits for a worker (no heartbeat yet)", async () => {
    await t.exec(
      `update public.shopping_runs set status = 'cancelled' where status in ('queued', 'running', 'needs_review')`,
    );
    const runId = await enqueue(t);
    await t.exec(
      `update public.shopping_runs set status = 'running', heartbeat_at = null, created_at = now() - interval '1 hour' where id = '${runId}'`,
    );
    const heartbeat = new Heartbeat({
      store: new RunStore(t.runner),
      queue: createPgmqClient(t.runner),
      log: recorder(),
      intervalSeconds: 30,
    });
    expect(await heartbeat.sweep()).toEqual({ requeued: [], failed: [] });
  });

  it("ticks on its interval: beat first, then sweep", async () => {
    const calls: string[] = [];
    const heartbeat = new Heartbeat({
      store: {
        heartbeat: async (ids) => {
          calls.push(`beat:${ids.length}`);
          return ids.length;
        },
        sweepStale: async () => {
          calls.push("sweep");
          return { requeued: [], failed: [] };
        },
      },
      queue: { setVisibility: async () => void calls.push("vt") },
      log: recorder(),
      intervalSeconds: 5,
    });
    heartbeat.hold("r", "1");
    await heartbeat.tick();
    expect(calls).toEqual(["beat:1", "vt", "sweep"]);
  });
});
