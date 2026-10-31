// Test-only: a worker wired to the PGlite harness, with MockRetailer as every adapter and push
// notifications captured instead of sent.
import type { PushPayload } from "@mp/agent";
import type { RetailerAdapter, RetailerId, Store } from "@mp/retailers";
import { MockRetailer } from "@mp/retailers/mock";
import type { AdapterSource } from "../adapters.ts";
import { Heartbeat } from "../heartbeat.ts";
import {
  createPgmqClient,
  type QueueClient,
  type QueueMessage,
  SHOPPING_RUN_QUEUE,
} from "../queue.ts";
import { type ModelSource, RunRunner } from "../runner.ts";
import { RunStore } from "../store.ts";
import { type RunsTestDb, recorder } from "./fixtures.ts";

export interface TestWorker {
  runner: RunRunner;
  store: RunStore;
  queue: QueueClient;
  heartbeat: Heartbeat;
  mock: MockRetailer;
  pushes: PushPayload[];
  log: ReturnType<typeof recorder>;
  /** Reads the next message (as pgmq would hand it out) and runs it through the handler. */
  next(signal?: AbortSignal): Promise<{ message: QueueMessage; outcome: string } | null>;
}

export function mockAdapters(mock: RetailerAdapter): AdapterSource {
  return {
    mode: "mock",
    get: (retailer: RetailerId) => (retailer === mock.id ? mock : null),
    storeFor: async (adapter, storeId): Promise<Store> => {
      const stores = await adapter.findStores("");
      const store = stores.find((s) => s.id === storeId) ?? stores[0];
      if (!store) throw new Error("no store");
      return store;
    },
  };
}

export function testWorker(
  t: RunsTestDb,
  options: {
    mock?: MockRetailer;
    adapter?: RetailerAdapter;
    models?: ModelSource | null;
    heartbeatSeconds?: number;
  } = {},
): TestWorker {
  const store = new RunStore(t.runner);
  const queue = createPgmqClient(t.runner);
  const log = recorder();
  const mock = options.mock ?? new MockRetailer({ seed: 1 });
  const heartbeat = new Heartbeat({
    store,
    queue,
    log,
    intervalSeconds: options.heartbeatSeconds ?? 30,
  });
  const pushes: PushPayload[] = [];
  const runner = new RunRunner({
    store,
    adapters: mockAdapters(options.adapter ?? mock),
    models: options.models ?? null,
    heartbeat,
    log,
    notify: async (_householdId, payload) => {
      pushes.push(payload);
    },
  });
  return {
    runner,
    store,
    queue,
    heartbeat,
    mock,
    pushes,
    log,
    async next(signal = new AbortController().signal) {
      const [message] = await queue.read(SHOPPING_RUN_QUEUE, 900, 1);
      if (!message) return null;
      const outcome = await runner.handle(message, signal);
      if (outcome === "requeued") await queue.setVisibility(SHOPPING_RUN_QUEUE, message.msgId, 0);
      else await queue.delete(SHOPPING_RUN_QUEUE, message.msgId);
      return { message, outcome };
    },
  };
}
