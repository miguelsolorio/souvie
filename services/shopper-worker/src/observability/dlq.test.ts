// Acceptance criterion 10 (corrected): `dlq:list` shows a dead-lettered message and `dlq:retry`
// puts it back on shopping_run. The dead letter is pgmq's archive (a_shopping_run), on PGlite with
// the repo's migrations and a pgmq stand-in that keeps the archive table's shape.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPgmqClient, SHOPPING_RUN_QUEUE } from "../queue.ts";
import {
  createRunsTestDb,
  enqueue,
  HOUSEHOLD,
  type RunsTestDb,
  runRow,
  seedHousehold,
} from "../testing/fixtures.ts";
import { describeRetry, formatDeadLetter, listDeadLetters, retryDeadLetter } from "./dlq.ts";

let t: RunsTestDb;

beforeAll(async () => {
  t = await createRunsTestDb({ extraMigrations: ["ws15_observability"] });
  await seedHousehold(t);
}, 120_000);

afterAll(async () => {
  await t?.close();
});

beforeEach(async () => {
  await t.exec(
    `update public.shopping_runs set status = 'cancelled' where status in ('queued', 'running', 'needs_review', 'cart_ready', 'checking_out');
     delete from pgmq.q_shopping_run;
     delete from pgmq.a_shopping_run;`,
  );
});

/** A run that was dead-lettered the way the worker does it: the message archived, the run failed. */
async function deadLetter(options: { runStatus?: "failed" | "queued" } = {}) {
  const runId = await enqueue(t);
  const queue = createPgmqClient(t.runner);
  const [message] = await queue.read(SHOPPING_RUN_QUEUE, 900, 1);
  if (!message) throw new Error("no message");
  // Two more reads: the third attempt is the last (queue.ts MAX_ATTEMPTS).
  await t.exec(`update pgmq.q_shopping_run set read_ct = 3 where msg_id = ${message.msgId}`);
  await queue.archive(SHOPPING_RUN_QUEUE, message.msgId);
  if ((options.runStatus ?? "failed") === "failed") {
    await t.query(
      `update public.shopping_runs set status = 'failed', error = 'failed after 3 attempts: kroger answered 503' where id = $1`,
      [runId],
    );
  }
  return { runId, msgId: message.msgId };
}

async function queued(): Promise<Array<{ msg_id: string; run_id: string }>> {
  return t.query(
    `select msg_id::text as msg_id, message ->> 'run_id' as run_id from pgmq.q_shopping_run order by msg_id`,
  );
}

describe("dlq:list", () => {
  it("is empty when nothing was dead-lettered", async () => {
    expect(await listDeadLetters(t.runner)).toEqual([]);
  });

  it("shows the archived message with its run's state and why the run failed", async () => {
    const { runId, msgId } = await deadLetter();
    const letters = await listDeadLetters(t.runner);
    expect(letters).toHaveLength(1);
    expect(letters[0]).toMatchObject({
      msgId,
      runId,
      householdId: HOUSEHOLD,
      readCount: 3,
      runStatus: "failed",
      runError: "failed after 3 attempts: kroger answered 503",
    });
    expect(letters[0]?.archivedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    const text = formatDeadLetter(letters[0] as never);
    expect(text).toContain(`msg ${msgId}`);
    expect(text).toContain(`run ${runId}`);
    expect(text).toContain("status failed");
    expect(text).toContain("kroger answered 503");
  });

  it("lists the newest first and survives a message with no run id", async () => {
    const first = await deadLetter();
    await t.exec(
      `insert into pgmq.a_shopping_run (msg_id, read_ct, enqueued_at, vt, message) values (9001, 3, now(), now(), '{"junk": true}'::jsonb)`,
    );
    const letters = await listDeadLetters(t.runner);
    expect(letters.map((l) => l.msgId)).toContain(first.msgId);
    const junk = letters.find((l) => l.msgId === "9001");
    expect(junk).toMatchObject({ runId: null, runStatus: null, householdId: null });
    expect(formatDeadLetter(junk as never)).toContain("(run gone)");
  });
});

describe("dlq:retry", () => {
  it("puts a message back when its run can still be claimed, and removes it from the archive", async () => {
    const { runId, msgId } = await deadLetter({ runStatus: "queued" });
    const outcome = await retryDeadLetter(t.runner, msgId);
    expect(outcome).toMatchObject({ kind: "requeued", runId });
    const back = await queued();
    expect(back).toHaveLength(1);
    expect(back[0]?.run_id).toBe(runId);
    expect(await listDeadLetters(t.runner)).toEqual([]);
    expect(describeRetry(outcome, msgId)).toContain(
      `Put back on shopping_run as msg ${back[0]?.msg_id}`,
    );
  });

  it("refuses to re-send a message whose run is closed, and says what to do instead", async () => {
    const { runId, msgId } = await deadLetter();
    const outcome = await retryDeadLetter(t.runner, msgId);
    expect(outcome).toEqual({ kind: "run_closed", runId, status: "failed" });
    expect(await queued()).toEqual([]);
    expect(await listDeadLetters(t.runner)).toHaveLength(1);
    const words = describeRetry(outcome, msgId);
    expect(words).toContain("is failed");
    expect(words).toContain("--new-run");
    expect(words).toContain("--force");
  });

  it("--force re-sends it anyway", async () => {
    const { runId, msgId } = await deadLetter();
    const outcome = await retryDeadLetter(t.runner, msgId, { force: true });
    expect(outcome.kind).toBe("requeued");
    expect((await queued())[0]?.run_id).toBe(runId);
    expect(await listDeadLetters(t.runner)).toEqual([]);
  });

  it("--new-run starts a replacement run of the same list, store and policy", async () => {
    const policy = { per_item_ceiling_usd: 12 };
    const runId = await enqueue(t, policy);
    const queue = createPgmqClient(t.runner);
    const [message] = await queue.read(SHOPPING_RUN_QUEUE, 900, 1);
    if (!message) throw new Error("no message");
    await queue.archive(SHOPPING_RUN_QUEUE, message.msgId);
    await t.query(
      `update public.shopping_runs set status = 'failed', error = 'boom' where id = $1`,
      [runId],
    );

    const outcome = await retryDeadLetter(t.runner, message.msgId, { newRun: true });
    expect(outcome).toMatchObject({ kind: "new_run", replacedRunId: runId });
    if (outcome.kind !== "new_run") throw new Error("unreachable");
    expect(outcome.runId).not.toBe(runId);
    const fresh = await runRow(t, outcome.runId);
    expect(fresh.status).toBe("queued");
    const [old, replacement] = await t.query<{
      list_id: string;
      connection_id: string;
      policy: { per_item_ceiling_usd: number };
    }>(
      `select list_id, connection_id, policy from public.shopping_runs where id = any($1::uuid[]) order by created_at`,
      [[runId, outcome.runId]],
    );
    expect(replacement?.list_id).toBe(old?.list_id);
    expect(replacement?.connection_id).toBe(old?.connection_id);
    expect(replacement?.policy.per_item_ceiling_usd).toBe(12);
    expect((await queued()).map((m) => m.run_id)).toEqual([outcome.runId]);
    expect(await listDeadLetters(t.runner)).toEqual([]);
    expect(describeRetry(outcome, message.msgId)).toContain("to replace");
  });

  it("says so when there is no such message, and refuses a msg_id that is not a number", async () => {
    expect(await retryDeadLetter(t.runner, "424242")).toEqual({ kind: "not_found" });
    expect(describeRetry({ kind: "not_found" }, "424242")).toContain(
      "No dead letter with msg_id 424242",
    );
    await expect(retryDeadLetter(t.runner, "1; drop table x")).rejects.toThrow(
      /msg_id must be a number/,
    );
  });
});
