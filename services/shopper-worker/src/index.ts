// The shopper worker (WS09): consumes the pgmq queue `shopping_run`, runs @mp/agent for each run
// message, and exits cleanly on SIGTERM. See README.md.
import { createAnthropicClient, createAnthropicToolClient } from "@mp/llm";
import postgres, { type Sql } from "postgres";
import { createAdapterSource } from "./adapters.ts";
import { describeConfig, readConfig } from "./config.ts";
import { Heartbeat } from "./heartbeat.ts";
import { createModelSource } from "./models.ts";
import { mountObservability } from "./observability/index.ts";
import { sendPush } from "./push.ts";
import {
  createPgmqClient,
  errorMessage,
  type Logger,
  POLL_INTERVAL_MS,
  runPoller,
  SHOPPING_RUN_QUEUE,
  sleep,
} from "./queue.ts";
import { type ModelSource, RunRunner } from "./runner.ts";
import { DRAIN_TIMEOUT_MS, handBack, installShutdown } from "./shutdown.ts";
import { type PgClient, runnerOf } from "./sql.ts";
import { RunStore } from "./store.ts";

const RECONNECT_DELAY_MS = 5_000;

function createLogger(service: string): Logger {
  const line = (level: string, msg: string, fields?: Record<string, unknown>) => {
    const extra = fields ? ` ${JSON.stringify(fields)}` : "";
    return `${new Date().toISOString()} ${level} [${service}] ${msg}${extra}`;
  };
  return {
    info: (msg, fields) => console.log(line("INFO", msg, fields)),
    warn: (msg, fields) => console.warn(line("WARN", msg, fields)),
    error: (msg, fields) => console.error(line("ERROR", msg, fields)),
  };
}

const log = createLogger("shopper-worker");

/** postgres.js connects lazily, so run one query to prove the connection. Retries until aborted. */
async function connect(
  databaseUrl: string,
  max: number,
  signal: AbortSignal,
): Promise<Sql | undefined> {
  const sql = postgres(databaseUrl, {
    max,
    connect_timeout: 10,
    onnotice: () => {},
    connection: { application_name: "shopper-worker" },
  });

  while (!signal.aborted) {
    try {
      const [row] = await sql<{ database: string; version: string }[]>`
        select current_database() as database, current_setting('server_version') as version
      `;
      log.info("connected", { database: row?.database, serverVersion: row?.version });
      return sql;
    } catch (error) {
      log.warn("database unavailable, retrying", {
        error: errorMessage(error),
        retryInMs: RECONNECT_DELAY_MS,
      });
      await sleep(RECONNECT_DELAY_MS, signal);
    }
  }

  await sql.end({ timeout: 1 });
  return undefined;
}

async function main(): Promise<void> {
  const config = readConfig(process.env);
  const controller = new AbortController();
  let store: RunStore | undefined;
  let queue: ReturnType<typeof createPgmqClient> | undefined;
  const inFlight = new Map<string, { msgId: string; message: unknown }>();

  void installShutdown({
    controller,
    log,
    onDeadline: async () => {
      if (store && queue) {
        await handBack(
          [...inFlight.values()].map((entry) => ({
            msgId: entry.msgId,
            readCount: 0,
            enqueuedAt: new Date(),
            message: entry.message,
          })),
          { store, queue, log },
        );
      }
    },
  });

  log.info("starting", {
    queue: SHOPPING_RUN_QUEUE,
    pollIntervalMs: POLL_INTERVAL_MS,
    ...describeConfig(config),
  });

  // The pool holds a connection per concurrent run, plus the poller and the heartbeat.
  const sql = await connect(config.databaseUrl, config.concurrency + 3, controller.signal);
  if (!sql) return;

  const runner = runnerOf(sql as unknown as PgClient);
  store = new RunStore(runner);
  queue = createPgmqClient(runner);
  const runStore = store;
  const queueClient = queue;

  let models: ModelSource | null = null;
  if (config.anthropicApiKey) {
    models = createModelSource({
      toolClient: await createAnthropicToolClient({ apiKey: config.anthropicApiKey }),
      parseClient: await createAnthropicClient({ apiKey: config.anthropicApiKey }),
      store: runStore,
      dailyCapUsd: config.aiDailyCapUsd,
      log,
    });
  }

  const heartbeat = new Heartbeat({
    store: runStore,
    queue: queueClient,
    log,
    intervalSeconds: config.heartbeatSeconds,
  });
  heartbeat.start();

  const runs = new RunRunner({
    store: runStore,
    adapters: createAdapterSource({
      mode: config.retailerMode,
      rpc: (fn, args) => runStore.rpc(fn, args),
      kroger: {
        clientId: config.krogerClientId,
        clientSecret: config.krogerClientSecret,
        baseUrl: config.krogerApiBase,
      },
    }),
    models,
    heartbeat,
    log,
    notify: async (householdId, payload) => {
      const tokens = await runStore.pushTokens(householdId);
      const result = await sendPush(
        tokens.map((t) => t.token),
        payload,
        { accessToken: config.expoPushAccessToken },
      );
      await runStore.removeTokens(householdId, result.invalid);
      log.info("push sent", {
        type: payload.type,
        devices: result.sent,
        errors: result.errors.length,
      });
    },
  });

  // Sentry, PostHog and the stall watch (WS15). Each is off without its key.
  await mountObservability({
    env: process.env,
    runs,
    store: runStore,
    log,
    signal: controller.signal,
  });

  try {
    const { abandoned } = await runPoller({
      client: queueClient,
      log,
      signal: controller.signal,
      concurrency: config.concurrency,
      drainTimeoutMs: DRAIN_TIMEOUT_MS,
      handle: async (message, signal) => {
        inFlight.set(message.msgId, { msgId: message.msgId, message: message.message });
        try {
          return await runs.handle(message, signal);
        } finally {
          inFlight.delete(message.msgId);
        }
      },
      onFailure: runs.onFailure,
    });
    await handBack(abandoned, { store: runStore, queue: queueClient, log });
  } finally {
    heartbeat.stop();
    await sql.end({ timeout: 2 });
    log.info("stopped");
  }
}

main().catch((error: unknown) => {
  log.error("fatal", { error: errorMessage(error) });
  process.exitCode = 1;
});
