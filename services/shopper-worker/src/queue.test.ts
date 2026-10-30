import { describe, expect, it } from "vitest";
import {
  type Logger,
  POLL_INTERVAL_MS,
  type QueueClient,
  type QueueMessage,
  runPoller,
  SHOPPING_RUN_QUEUE,
  sleep,
} from "./queue";

interface Entry {
  level: "info" | "warn" | "error";
  msg: string;
  fields?: Record<string, unknown>;
}

function recorder(): Logger & { entries: Entry[] } {
  const entries: Entry[] = [];
  return {
    entries,
    info: (msg, fields) => entries.push({ level: "info", msg, fields }),
    warn: (msg, fields) => entries.push({ level: "warn", msg, fields }),
    error: (msg, fields) => entries.push({ level: "error", msg, fields }),
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
  message: { runId: "r1" },
};

describe("runPoller", () => {
  it("logs idle on every empty poll of the shopping_run queue, every 5 seconds", async () => {
    const reads: Array<[string, number, number]> = [];
    const client: QueueClient = {
      exists: async () => true,
      read: async (queue, vt, qty) => {
        reads.push([queue, vt, qty]);
        return [];
      },
    };
    const log = recorder();
    const controller = new AbortController();
    const { wait, waits } = stopAfter(3, controller);

    await runPoller({ client, log, signal: controller.signal, wait });

    expect(log.entries.filter((e) => e.msg === "idle")).toHaveLength(3);
    expect(reads).toEqual([
      [SHOPPING_RUN_QUEUE, 30, 1],
      [SHOPPING_RUN_QUEUE, 30, 1],
      [SHOPPING_RUN_QUEUE, 30, 1],
    ]);
    expect(waits).toEqual([POLL_INTERVAL_MS, POLL_INTERVAL_MS, POLL_INTERVAL_MS]);
  });

  it("stays idle while the queue does not exist, warns once, and picks it up once created", async () => {
    let created = false;
    let existsCalls = 0;
    const client: QueueClient = {
      exists: async () => {
        existsCalls += 1;
        return created;
      },
      read: async () => [],
    };
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
    // Existence is checked until the queue appears, then never again.
    expect(existsCalls).toBe(3);
  });

  it("passes messages to the handler and does not log idle for that tick", async () => {
    const handled: string[] = [];
    const client: QueueClient = { exists: async () => true, read: async () => [message] };
    const log = recorder();
    const controller = new AbortController();
    const { wait } = stopAfter(1, controller);

    await runPoller({
      client,
      log,
      signal: controller.signal,
      wait,
      handle: async (m) => {
        handled.push(m.msgId);
      },
    });

    expect(handled).toEqual(["1"]);
    expect(log.entries.some((e) => e.msg === "idle")).toBe(false);
  });

  it("logs a failed poll and keeps polling", async () => {
    let calls = 0;
    const client: QueueClient = {
      exists: async () => true,
      read: async () => {
        calls += 1;
        if (calls === 1) throw new Error("connection reset");
        return [];
      },
    };
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
    const client: QueueClient = {
      exists: async () => {
        throw new Error("should not be called");
      },
      read: async () => [],
    };
    const log = recorder();
    await runPoller({ client, log, signal: controller.signal });
    expect(log.entries).toEqual([]);
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
