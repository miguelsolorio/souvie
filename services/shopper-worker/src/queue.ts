import type { Sql } from "postgres";

/** pgmq queue the worker consumes. Created by the WS09 `runs` migration (docs/02-data-model.md). */
export const SHOPPING_RUN_QUEUE = "shopping_run";
export const POLL_INTERVAL_MS = 5_000;
/** Seconds a read message stays invisible to other readers before pgmq hands it out again. */
export const VISIBILITY_TIMEOUT_S = 30;

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
}

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export type MessageHandler = (message: QueueMessage) => Promise<void>;

interface ReadRow {
  msg_id: string;
  read_ct: number;
  enqueued_at: Date;
  message: unknown;
}

export function createPgmqClient(sql: Sql): QueueClient {
  return {
    async exists(queue) {
      const rows = await sql<{ found: boolean }[]>`
        select exists (select 1 from pgmq.list_queues() where queue_name = ${queue}) as found
      `;
      return rows[0]?.found ?? false;
    },
    async read(queue, visibilityTimeoutS, qty) {
      const rows = await sql<ReadRow[]>`
        select msg_id, read_ct, enqueued_at, message
        from pgmq.read(${queue}::text, ${visibilityTimeoutS}::integer, ${qty}::integer)
      `;
      return rows.map((row) => ({
        msgId: String(row.msg_id),
        readCount: row.read_ct,
        enqueuedAt: row.enqueued_at,
        message: row.message,
      }));
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

/**
 * WS00 has no job handler. It logs the message and leaves it in the queue, so pgmq
 * makes it visible again after the visibility timeout. WS09 replaces this.
 */
export function placeholderHandler(log: Logger): MessageHandler {
  return async (message) => {
    log.warn("message received but no handler is registered (WS09)", {
      msgId: message.msgId,
      readCount: message.readCount,
    });
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
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Polls `queue` every `intervalMs` until `signal` aborts. Logs "idle" on every empty poll,
 * including while the queue does not exist yet. A failed poll is logged and retried on the
 * next tick; postgres.js reconnects on its own.
 */
export async function runPoller(options: PollerOptions): Promise<void> {
  const {
    client,
    log,
    signal,
    queue = SHOPPING_RUN_QUEUE,
    intervalMs = POLL_INTERVAL_MS,
    visibilityTimeoutS = VISIBILITY_TIMEOUT_S,
    handle = placeholderHandler(log),
    wait = sleep,
  } = options;

  let queueFound = false;
  let warnedMissing = false;

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
        const messages = await client.read(queue, visibilityTimeoutS, 1);
        if (messages.length === 0) {
          log.info("idle", { queue });
        }
        for (const message of messages) {
          await handle(message);
        }
      }
    } catch (error) {
      log.error("poll failed", { queue, error: errorMessage(error) });
    }

    await wait(intervalMs, signal);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
