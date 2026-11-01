// WS15 fix round: what `dlq:retry` refuses (review blockers 2 and 3).
//
//   2. `--new-run` ignored the run's status. On a cart_ready or checked_out run it made a second run
//      on the same list, and the replacement copied the old policy, auto_checkout included, so a
//      second order was possible. Now it is refused for queued, running, needs_review, cart_ready,
//      checking_out and checked_out, with or without --force; allowed for failed and cancelled; and
//      the replacement never auto-checks-out.
//   3. A retry could put a second live message on a run that already had one, and two workers would
//      take one run. Now a live message for that run refuses the retry, under an advisory lock.
//
// On PGlite with the repo's migrations and a pgmq stand-in that keeps the archive table's shape.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPgmqClient, SHOPPING_RUN_QUEUE } from "../queue.ts";
import type { SqlRunner } from "../sql.ts";
import {
  CONNECTION,
  createRunsTestDb,
  enqueue,
  LIST,
  type RunsTestDb,
  runRow,
  seedHousehold,
} from "../testing/fixtures.ts";
import {
  describeRetry,
  listDeadLetters,
  NEW_RUN_REFUSED_STATUSES,
  retryDeadLetter,
} from "./dlq.ts";

let t: RunsTestDb;

beforeAll(async () => {
  t = await createRunsTestDb({ extraMigrations: ["ws15_observability"] });
  await seedHousehold(t);
}, 120_000);

afterAll(async () => {
  await t?.close();
});

beforeEach(async () => {
  // Runs go too: a household may start 20 a day, and these tests start more than that.
  await t.exec(
    `delete from public.shopping_runs;
     delete from pgmq.q_shopping_run;
     delete from pgmq.a_shopping_run;`,
  );
});

/** The statuses a run can be in, and the transitions that lead there from queued. */
const PATH: Record<string, string[]> = {
  queued: [],
  running: ["running"],
  needs_review: ["running", "needs_review"],
  cart_ready: ["running", "cart_ready"],
  checking_out: ["running", "cart_ready", "checking_out"],
  checked_out: ["running", "cart_ready", "checking_out", "checked_out"],
  failed: ["failed"],
  cancelled: ["cancelled"],
};

async function moveTo(runId: string, status: string) {
  for (const step of PATH[status] ?? []) {
    await t.query(
      `update public.shopping_runs set status = $2::public.shopping_runs_status where id = $1`,
      [runId, step],
    );
  }
}

/** A run in `status` whose queue message sits in the dead letter archive. */
async function archivedRun(status: string, policy: Record<string, unknown> = {}) {
  const runId = await enqueue(t, policy);
  const queue = createPgmqClient(t.runner);
  const [message] = await queue.read(SHOPPING_RUN_QUEUE, 900, 1);
  if (!message) throw new Error("no message");
  await queue.archive(SHOPPING_RUN_QUEUE, message.msgId);
  await moveTo(runId, status);
  return { runId, msgId: message.msgId };
}

const AUTO_POLICY = { auto_checkout: true, auto_checkout_cap_usd: 50, per_item_ceiling_usd: 12 };

async function runCount(): Promise<number> {
  const rows = await t.query<{ n: number }>(`select count(*)::int as n from public.shopping_runs`);
  return rows[0]?.n ?? 0;
}

async function live(): Promise<Array<{ msg_id: string; run_id: string }>> {
  return t.query(
    `select msg_id::text as msg_id, message ->> 'run_id' as run_id from pgmq.q_shopping_run order by msg_id`,
  );
}

const FLAGS = [
  ["--new-run", { newRun: true }],
  ["--new-run --force", { newRun: true, force: true }],
] as const;

describe("dlq:retry --new-run and the run's status (blocker 2)", () => {
  it("refuses for exactly the statuses that are alive or hold a cart or an order", () => {
    expect([...NEW_RUN_REFUSED_STATUSES].sort()).toEqual([
      "cart_ready",
      "checked_out",
      "checking_out",
      "needs_review",
      "queued",
      "running",
    ]);
  });

  describe.each(FLAGS)("%s", (_label, options) => {
    it.each(["queued", "running", "needs_review", "cart_ready", "checking_out", "checked_out"])(
      "is refused for a %s run: no second run, the archive untouched",
      async (status) => {
        const { runId, msgId } = await archivedRun(status, AUTO_POLICY);
        const before = await runCount();
        const outcome = await retryDeadLetter(t.runner, msgId, options);
        expect(outcome).toEqual({ kind: "new_run_refused", runId, status });
        expect(await runCount()).toBe(before);
        expect(await live()).toEqual([]);
        expect(await listDeadLetters(t.runner)).toHaveLength(1);
        const words = describeRetry(outcome, msgId);
        expect(words).toContain(`is ${status}`);
        expect(words).toContain("second order");
        expect(words).toContain("Nothing was changed");
      },
    );

    it.each(["failed", "cancelled"])(
      "starts a replacement for a %s run, with auto_checkout off whatever the old policy said",
      async (status) => {
        const { runId, msgId } = await archivedRun(status, AUTO_POLICY);
        expect((await runRow(t, runId)).status).toBe(status);
        const outcome = await retryDeadLetter(t.runner, msgId, options);
        expect(outcome).toMatchObject({ kind: "new_run", replacedRunId: runId });
        if (outcome.kind !== "new_run") throw new Error("unreachable");

        const rows = await t.query<{
          list_id: string;
          connection_id: string;
          status: string;
          policy: Record<string, unknown>;
        }>(
          `select list_id, connection_id, status, policy from public.shopping_runs where id = $1`,
          [outcome.runId],
        );
        expect(rows[0]).toMatchObject({
          list_id: LIST,
          connection_id: CONNECTION,
          status: "queued",
        });
        expect(rows[0]?.policy).toMatchObject({
          auto_checkout: false,
          auto_checkout_cap_usd: null,
          // the rest of the policy is the old run's
          per_item_ceiling_usd: 12,
        });
        // The old run is as it was, and its message left the archive for the new run's.
        expect((await runRow(t, runId)).status).toBe(status);
        expect((await live()).map((m) => m.run_id)).toEqual([outcome.runId]);
        expect(await listDeadLetters(t.runner)).toEqual([]);
      },
    );

    it("starts nothing when the run record is gone: there is no list to copy", async () => {
      const gone = "5a0000aa-0000-4000-8000-0000000000ff";
      await t.exec(
        `insert into pgmq.a_shopping_run (msg_id, read_ct, enqueued_at, vt, message) values (9301, 3, now(), now(), '{"run_id": "${gone}"}'::jsonb)`,
      );
      const before = await runCount();
      const outcome = await retryDeadLetter(t.runner, "9301", options);
      expect(outcome).toEqual({ kind: "run_closed", runId: gone, status: null });
      expect(await runCount()).toBe(before);
      expect(await listDeadLetters(t.runner)).toHaveLength(1);
    });
  });

  it("--force alone still re-sends the message of a run that is gone, as before", async () => {
    const gone = "5a0000aa-0000-4000-8000-0000000000fe";
    await t.exec(
      `insert into pgmq.a_shopping_run (msg_id, read_ct, enqueued_at, vt, message) values (9302, 3, now(), now(), '{"run_id": "${gone}"}'::jsonb)`,
    );
    const outcome = await retryDeadLetter(t.runner, "9302", { force: true });
    expect(outcome).toMatchObject({ kind: "requeued", runId: gone });
    expect((await live()).map((m) => m.run_id)).toEqual([gone]);
  });
});

describe("dlq:retry and a message that is already waiting (blocker 3)", () => {
  /** A dead letter for a run, put straight in the archive with a made-up message id. */
  async function archiveMessage(msgId: number, runId: string) {
    await t.exec(
      `insert into pgmq.a_shopping_run (msg_id, read_ct, enqueued_at, vt, message) values (${msgId}, 3, now(), now(), '{"run_id": "${runId}"}'::jsonb)`,
    );
  }

  it("refuses when the run has a live message, and says which; the archive and the queue are as they were", async () => {
    const runId = await enqueue(t); // queued, with its message waiting
    const waiting = await live();
    expect(waiting).toHaveLength(1);
    await archiveMessage(9101, runId);

    const outcome = await retryDeadLetter(t.runner, "9101");
    expect(outcome).toEqual({
      kind: "already_queued",
      runId,
      liveMsgIds: [waiting[0]?.msg_id],
    });
    expect(await live()).toEqual(waiting);
    expect(await listDeadLetters(t.runner)).toHaveLength(1);
    const words = describeRetry(outcome, "9101");
    expect(words).toContain(`msg ${waiting[0]?.msg_id}`);
    expect(words).toContain("two workers");
    expect(words).toContain("Nothing was changed");
  });

  it("refuses with --force too", async () => {
    const runId = await enqueue(t);
    await archiveMessage(9103, runId);
    const outcome = await retryDeadLetter(t.runner, "9103", { force: true });
    expect(outcome.kind).toBe("already_queued");
    expect(await live()).toHaveLength(1);
  });

  it("two archived messages for one run, retried in sequence, leave exactly one live message", async () => {
    const runId = await enqueue(t);
    await t.exec("delete from pgmq.q_shopping_run"); // its first message is gone; two archived remain
    await archiveMessage(9111, runId);
    await archiveMessage(9112, runId);

    const first = await retryDeadLetter(t.runner, "9111");
    expect(first).toMatchObject({ kind: "requeued", runId });
    expect(await live()).toHaveLength(1);

    const second = await retryDeadLetter(t.runner, "9112");
    expect(second.kind).toBe("already_queued");
    expect(await live()).toHaveLength(1);
    expect((await live())[0]?.run_id).toBe(runId);
    // The one that went back left the archive; the refused one is still there to look at.
    expect((await listDeadLetters(t.runner)).map((l) => l.msgId)).toEqual(["9112"]);
  });

  it("two retries started at once end with one live message", async () => {
    const runId = await enqueue(t);
    await t.exec("delete from pgmq.q_shopping_run");
    await archiveMessage(9121, runId);
    await archiveMessage(9122, runId);
    const outcomes = await Promise.all([
      retryDeadLetter(t.runner, "9121"),
      retryDeadLetter(t.runner, "9122"),
    ]);
    expect(outcomes.map((o) => o.kind).sort()).toEqual(["already_queued", "requeued"]);
    expect(await live()).toHaveLength(1);
  });

  it("looks for a live message under an advisory lock on the run, before it sends", async () => {
    const runId = await enqueue(t);
    await t.exec("delete from pgmq.q_shopping_run");
    await archiveMessage(9131, runId);
    const statements: string[] = [];
    const watch = (inner: SqlRunner): SqlRunner => ({
      query: (text, params) => {
        statements.push(text);
        return inner.query(text, params);
      },
      transaction: (fn) => inner.transaction((tx) => fn(watch(tx))),
    });
    await retryDeadLetter(watch(t.runner), "9131");
    const at = (needle: string) => statements.findIndex((s) => s.includes(needle));
    expect(at("pg_advisory_xact_lock")).toBeGreaterThan(-1);
    expect(at("pg_advisory_xact_lock")).toBeLessThan(at("pgmq.q_shopping_run"));
    expect(at("pgmq.q_shopping_run")).toBeLessThan(at("pgmq.send"));
  });

  it("does not look for a live message when it is only describing a closed run", async () => {
    const { msgId } = await archivedRun("failed");
    const statements: string[] = [];
    const watch = (inner: SqlRunner): SqlRunner => ({
      query: (text, params) => {
        statements.push(text);
        return inner.query(text, params);
      },
      transaction: (fn) => inner.transaction((tx) => fn(watch(tx))),
    });
    const outcome = await retryDeadLetter(watch(t.runner), msgId);
    expect(outcome.kind).toBe("run_closed");
    expect(statements.some((s) => s.includes("pg_advisory_xact_lock"))).toBe(false);
  });
});
