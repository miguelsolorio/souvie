// The dead letter queue (WS15, orchestrator correction 4). There is no separate queue: the third
// failed attempt of a message archives it, and pgmq keeps archived messages in
// `pgmq.a_shopping_run`. That archive is the dead letter. `pnpm --filter @mp/shopper-worker
// dlq:list` shows it and `dlq:retry <msg_id>` puts a message back on `shopping_run`.
//
// A dead-lettered run is `failed` (the worker failed it with the error on the last attempt), and
// the state machine has no way out of failed, for any writer. So a retry has three outcomes:
//   * the run is still claimable (queued, or running with no heartbeat): the message goes back as
//     is and a worker takes it;
//   * the run is closed: the retry refuses and says so, because a worker would only ack the
//     message as "not claimable". `--new-run` starts a replacement run of the same list at the same
//     store with the same policy, through enqueue_shopping_run, and `--force` re-sends the message
//     anyway (for looking at what a worker does with it);
//   * the message is not in the archive: nothing happens.
// Either way the archive row is removed once the message is back, so the list shows what is left.
//
// pgmq belongs to the connection role (the service role has no grant on it), so this runs as the
// database owner over WORKER_DATABASE_URL, like the worker's own queue calls.
import { SHOPPING_RUN_QUEUE } from "../queue.ts";
import type { SqlRunner } from "../sql.ts";

const ARCHIVE = `pgmq.a_${SHOPPING_RUN_QUEUE}`;
const UUID = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

export interface DeadLetter {
  msgId: string;
  runId: string | null;
  householdId: string | null;
  /** Times a worker read the message before it gave up. */
  readCount: number;
  enqueuedAt: string;
  archivedAt: string;
  /** shopping_runs.status now; null when the run row is gone. */
  runStatus: string | null;
  /** shopping_runs.error: why the worker failed the run. */
  runError: string | null;
}

interface ListRow {
  msg_id: string;
  run_id: string | null;
  household_id: string | null;
  read_ct: number;
  enqueued_at: Date | string;
  archived_at: Date | string;
  run_status: string | null;
  run_error: string | null;
}

const iso = (value: Date | string) => new Date(value).toISOString();

/** The archived messages of the shopping_run queue, newest first, with their run's state. */
export async function listDeadLetters(sql: SqlRunner, limit = 50): Promise<DeadLetter[]> {
  const rows = await sql.query<ListRow>(
    `select a.msg_id::text as msg_id, a.message ->> 'run_id' as run_id, r.household_id,
            a.read_ct, a.enqueued_at, a.archived_at, r.status::text as run_status, r.error as run_error
       from ${ARCHIVE} a
       left join public.shopping_runs r
         on r.id = case when (a.message ->> 'run_id') ~* '${UUID}' then (a.message ->> 'run_id')::uuid end
      order by a.archived_at desc, a.msg_id desc
      limit $1::integer`,
    [limit],
  );
  return rows.map((row) => ({
    msgId: row.msg_id,
    runId: row.run_id,
    householdId: row.household_id,
    readCount: row.read_ct,
    enqueuedAt: iso(row.enqueued_at),
    archivedAt: iso(row.archived_at),
    runStatus: row.run_status,
    runError: row.run_error,
  }));
}

export type RetryOutcome =
  | { kind: "not_found" }
  | { kind: "requeued"; msgId: string; runId: string | null }
  | { kind: "new_run"; runId: string; replacedRunId: string | null }
  | { kind: "run_closed"; runId: string | null; status: string | null };

export interface RetryOptions {
  /** Re-send the message although its run is closed. */
  force?: boolean;
  /** Start a replacement run of the same list, store and policy instead. */
  newRun?: boolean;
}

interface ArchivedRow {
  message: { run_id?: unknown } | null;
}

interface RunRow {
  status: string;
  claimable: boolean;
  list_id: string;
  connection_id: string | null;
  policy: unknown;
}

/** Puts a dead-lettered message back on shopping_run. See the file header for the three outcomes. */
export async function retryDeadLetter(
  sql: SqlRunner,
  msgId: string,
  options: RetryOptions = {},
): Promise<RetryOutcome> {
  if (!/^\d{1,18}$/.test(msgId)) throw new Error(`msg_id must be a number, not "${msgId}"`);
  return sql.transaction(async (tx) => {
    const archived = await tx.query<ArchivedRow>(
      `select a.message from ${ARCHIVE} a where a.msg_id = $1::bigint for update`,
      [msgId],
    );
    const row = archived[0];
    if (!row) return { kind: "not_found" } as const;

    const rawRunId = typeof row.message?.run_id === "string" ? row.message.run_id : null;
    const runId = rawRunId && new RegExp(UUID, "i").test(rawRunId) ? rawRunId.toLowerCase() : null;
    const runs = runId
      ? await tx.query<RunRow>(
          `select r.status::text as status, r.list_id, r.connection_id, r.policy,
                  (r.status = 'queued' or (r.status = 'running' and r.heartbeat_at is null)) as claimable
             from public.shopping_runs r where r.id = $1::uuid`,
          [runId],
        )
      : [];
    const run = runs[0];

    if (options.newRun) {
      if (!run) return { kind: "run_closed", runId, status: null } as const;
      const created = await tx.query<{ run_id: string }>(
        `select public.enqueue_shopping_run($1::uuid, $2::uuid, 'manual', $3::text::jsonb) as run_id`,
        [run.list_id, run.connection_id, JSON.stringify(run.policy ?? {})],
      );
      await tx.query(`delete from ${ARCHIVE} where msg_id = $1::bigint`, [msgId]);
      return { kind: "new_run", runId: created[0]?.run_id ?? "", replacedRunId: runId } as const;
    }

    if (!options.force && !(run?.claimable ?? false)) {
      return { kind: "run_closed", runId, status: run?.status ?? null } as const;
    }
    const sent = await tx.query<{ msg_id: string }>(
      `select s::text as msg_id from pgmq.send($1::text, $2::text::jsonb, 0) s`,
      [SHOPPING_RUN_QUEUE, JSON.stringify(row.message ?? {})],
    );
    await tx.query(`delete from ${ARCHIVE} where msg_id = $1::bigint`, [msgId]);
    return { kind: "requeued", msgId: sent[0]?.msg_id ?? "", runId } as const;
  });
}

/** One dead letter as a line of the list output. */
export function formatDeadLetter(letter: DeadLetter): string {
  const parts = [
    `msg ${letter.msgId}`,
    `run ${letter.runId ?? "(none)"}`,
    `status ${letter.runStatus ?? "(run gone)"}`,
    `read ${letter.readCount}x`,
    `archived ${letter.archivedAt}`,
  ];
  const head = parts.join("  ");
  return letter.runError ? `${head}\n    ${letter.runError.slice(0, 240)}` : head;
}

/** What the retry printed, in words. */
export function describeRetry(outcome: RetryOutcome, msgId: string): string {
  switch (outcome.kind) {
    case "not_found":
      return `No dead letter with msg_id ${msgId}. Run dlq:list to see them.`;
    case "requeued":
      return `Put back on ${SHOPPING_RUN_QUEUE} as msg ${outcome.msgId}${outcome.runId ? ` (run ${outcome.runId})` : ""}.`;
    case "new_run":
      return `Started run ${outcome.runId} to replace ${outcome.replacedRunId ?? "the lost run"}. The message left the archive.`;
    case "run_closed":
      return [
        `Run ${outcome.runId ?? "(none)"} is ${outcome.status ?? "gone"}, and a closed run cannot be revived: the state machine has no way out of failed.`,
        "A worker would only ack the message as not claimable. Use --new-run to start a replacement run of the same list, or --force to re-send the message anyway.",
      ].join("\n");
  }
}
