import type { SqlRunner } from "./sql.ts";

// The shopping_run queue (Supabase Queues, pgmq). WS00 built the poll loop; WS09 adds the claim,
// the ack, retries and the dead letter.
//
//   claim        pgmq.read with a 15 minute visibility timeout: no other reader sees the message
//                while this worker holds it. The heartbeat extends it (heartbeat.ts), and the run
//                row's own claim (store.ts) is the second lock.
//   ack          pgmq.delete once the run is through its phase.
//   retry        a failed attempt makes the message visible again after a short backoff.
//   dead letter  the third failed attempt archives the message (pgmq.archive keeps it in
//                pgmq.a_shopping_run) and the run is marked failed with the error.
//
// pgmq runs as the connection role: the service role has no grant on the pgmq schema
// (supabase/tests/ws09_runs_rls.sql), and this worker widens nothing.

/** pgmq queue the worker consumes. Created by the WS09 runs migration. */
export const SHOPPING_RUN_QUEUE = "shopping_run";
export const POLL_INTERVAL_MS = 5_000;
/** Seconds a claimed message stays invisible to other readers (the brief: 15 minutes). */
export const VISIBILITY_TIMEOUT_S = 900;
/** Attempts before a message goes to the dead-letter archive. */
export const MAX_ATTEMPTS = 3;
/** Seconds before a failed attempt is retried, times the attempt number. */
export const RETRY_BACKOFF_S = 30;

export interface QueueMessage {
  msgId: string;
  readCount: number;
  enqueuedAt: Date;
  message: unknown;
}

/** The pgmq calls the worker needs, kept narrow so tests can fake them. */
export interface QueueClient {
  exists(queue: string): Promise<boolean>;
  read(queue: string, visibilityTimeoutS: number, qty: number): Promise<QueueMessage[]>;
  /** Ack: the message is done. */
  delete(queue: string, msgId: string): Promise<boolean>;
  /** Dead letter: the message moves to the queue's archive table. */
  archive(queue: string, msgId: string): Promise<boolean>;
  /** Makes the message visible again in `seconds` (0: now). */
  setVisibility(queue: string, msgId: string, seconds: number): Promise<void>;
}

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** done: ack the message. requeued: the run went back to queued; let another worker take it now. */
export type HandlerOutcome = "done" | "requeued";

export type MessageHandler = (
  message: QueueMessage,
  signal: AbortSignal,
) => Promise<HandlerOutcome | undefined>;

/** Told about every failed attempt. `final` is the third: the run must be failed. */
export type FailureHandler = (
  message: QueueMessage,
  error: unknown,
  final: boolean,
) => Promise<void>;

interface ReadRow {
  msg_id: string | number;
  read_ct: number;
  enqueued_at: Date | string;
  message: unknown;
}

/** The pgmq client over a SqlRunner: postgres.js in production, PGlite in the tests. */
export function createPgmqClient(sql: SqlRunner): QueueClient {
  return {
    async exists(queue) {
      const rows = await sql.query<{ found: boolean }>(
        "select exists (select 1 from pgmq.list_queues() q where q.queue_name = $1) as found",
        [queue],
      );
      return rows[0]?.found ?? false;
    },
    async read(queue, visibilityTimeoutS, qty) {
      const rows = await sql.query<ReadRow>(
        `select msg_id, read_ct, enqueued_at, message
           from pgmq.read($1::text, $2::integer, $3::integer)`,
        [queue, visibilityTimeoutS, qty],
      );
      return rows.map((row) => ({
        msgId: String(row.msg_id),
        readCount: row.read_ct,
        enqueuedAt: new Date(row.enqueued_at),
        message: row.message,
      }));
    },
    async delete(queue, msgId) {
      const rows = await sql.query<{ ok: boolean }>(
        "select pgmq.delete($1::text, $2::bigint) as ok",
        [queue, msgId],
      );
      return rows[0]?.ok ?? false;
    },
    async archive(queue, msgId) {
      const rows = await sql.query<{ ok: boolean }>(
        "select pgmq.archive($1::text, $2::bigint) as ok",
        [queue, msgId],
      );
      return rows[0]?.ok ?? false;
    },
    async setVisibility(queue, msgId, seconds) {
      await sql.query("select msg_id from pgmq.set_vt($1::text, $2::bigint, $3::integer)", [
        queue,
        msgId,
        Math.max(0, Math.round(seconds)),
      ]);
    },
  };
}

/** Resolves after `ms`, or at once when `signal` aborts. Never rejects. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Before WS09 the worker had no handler; kept for a worker started with no runner. */
export function placeholderHandler(log: Logger): MessageHandler {
  return async (message) => {
    log.warn("message received but no handler is registered", {
      msgId: message.msgId,
      readCount: message.readCount,
    });
    return "requeued";
  };
}

export interface PollerOptions {
  client: QueueClient;
  log: Logger;
  signal: AbortSignal;
  queue?: string;
  intervalMs?: number;
  visibilityTimeoutS?: number;
  handle?: MessageHandler;
  onFailure?: FailureHandler;
  /** Messages handled at once (WORKER_CONCURRENCY). Default 1. */
  concurrency?: number;
  maxAttempts?: number;
  retryBackoffS?: number;
  /** How long to wait for in-flight handlers once `signal` aborts. Default 8 seconds. */
  drainTimeoutMs?: number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface PollerResult {
  /** Messages whose handler had not finished when the drain timed out. */
  abandoned: QueueMessage[];
}

/** Handles one message to the end: ack, retry, or dead letter. Never throws. */
export async function processMessage(
  message: QueueMessage,
  options: Required<
    Pick<PollerOptions, "client" | "log" | "queue" | "maxAttempts" | "retryBackoffS">
  > &
    Pick<PollerOptions, "onFailure"> & { handle: MessageHandler; signal: AbortSignal },
): Promise<void> {
  const { client, log, queue } = options;
  try {
    const outcome = await options.handle(message, options.signal);
    if (outcome === "requeued") {
      await client.setVisibility(queue, message.msgId, 0);
      log.info("message handed back", { msgId: message.msgId });
    } else {
      await client.delete(queue, message.msgId);
    }
  } catch (error) {
    const final = message.readCount >= options.maxAttempts;
    log.error(
      final ? "message failed for the last time, dead-lettered" : "message failed, will retry",
      {
        msgId: message.msgId,
        attempt: message.readCount,
        error: errorMessage(error),
      },
    );
    try {
      await options.onFailure?.(message, error, final);
    } catch (failure) {
      log.error("failure handler failed", { msgId: message.msgId, error: errorMessage(failure) });
    }
    try {
      if (final) await client.archive(queue, message.msgId);
      else
        await client.setVisibility(queue, message.msgId, options.retryBackoffS * message.readCount);
    } catch (queueError) {
      log.error("could not update the message after a failure", {
        msgId: message.msgId,
        error: errorMessage(queueError),
      });
    }
  }
}

/**
 * Polls `queue` every `intervalMs` until `signal` aborts, keeping up to `concurrency` messages in
 * flight. Logs "idle" on an empty poll with nothing in flight, including while the queue does not
 * exist yet. A failed poll is logged and retried on the next tick; postgres.js reconnects on its
 * own. After the abort it waits up to `drainTimeoutMs` for the handlers, which stop at their next
 * check and hand their runs back.
 */
export async function runPoller(options: PollerOptions): Promise<PollerResult> {
  const {
    client,
    log,
    signal,
    queue = SHOPPING_RUN_QUEUE,
    intervalMs = POLL_INTERVAL_MS,
    visibilityTimeoutS = VISIBILITY_TIMEOUT_S,
    handle = placeholderHandler(log),
    concurrency = 1,
    maxAttempts = MAX_ATTEMPTS,
    retryBackoffS = RETRY_BACKOFF_S,
    drainTimeoutMs = 8_000,
    wait = sleep,
  } = options;

  let queueFound = false;
  let warnedMissing = false;
  const inFlight = new Map<string, { message: QueueMessage; done: Promise<void> }>();

  while (!signal.aborted) {
    try {
      if (!queueFound) {
        queueFound = await client.exists(queue);
        if (!queueFound && !warnedMissing) {
          log.warn("queue does not exist yet; the WS09 runs migration creates it", { queue });
          warnedMissing = true;
        }
      }

      if (!queueFound) {
        log.info("idle", { queue, reason: "queue_missing" });
      } else {
        const room = Math.max(0, concurrency - inFlight.size);
        const messages = room > 0 ? await client.read(queue, visibilityTimeoutS, room) : [];
        if (messages.length === 0 && inFlight.size === 0) {
          log.info("idle", { queue });
        }
        for (const message of messages) {
          const done = processMessage(message, {
            client,
            log,
            queue,
            maxAttempts,
            retryBackoffS,
            onFailure: options.onFailure,
            handle,
            signal,
          }).finally(() => inFlight.delete(message.msgId));
          inFlight.set(message.msgId, { message, done });
        }
      }
    } catch (error) {
      log.error("poll failed", { queue, error: errorMessage(error) });
    }

    await wait(intervalMs, signal);
  }

  if (inFlight.size === 0) return { abandoned: [] };
  log.info("waiting for in-flight runs to hand back", { count: inFlight.size });
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled([...inFlight.values()].map((entry) => entry.done)),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, drainTimeoutMs);
    }),
  ]);
  clearTimeout(timer);
  return { abandoned: [...inFlight.values()].map((entry) => entry.message) };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
