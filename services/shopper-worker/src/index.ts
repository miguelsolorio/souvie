import postgres, { type Sql } from "postgres";
import {
  createPgmqClient,
  errorMessage,
  type Logger,
  POLL_INTERVAL_MS,
  runPoller,
  SHOPPING_RUN_QUEUE,
  sleep,
} from "./queue";

const RECONNECT_DELAY_MS = 5_000;

interface WorkerConfig {
  databaseUrl: string;
  sentryDsn: string | undefined;
}

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

function readConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const databaseUrl = env.WORKER_DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error(
      "WORKER_DATABASE_URL is not set. Copy .env.example to .env.local and add the database connection string.",
    );
  }
  // Sentry is wired in WS15. WS00 only reads the variable.
  return { databaseUrl, sentryDsn: env.SENTRY_DSN?.trim() || undefined };
}

/** postgres.js connects lazily, so run one query to prove the connection. Retries until aborted. */
async function connect(databaseUrl: string, signal: AbortSignal): Promise<Sql | undefined> {
  const sql = postgres(databaseUrl, {
    max: 2,
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
  for (const name of ["SIGINT", "SIGTERM"] as const) {
    process.once(name, () => {
      log.info("shutting down", { signal: name });
      controller.abort();
    });
  }

  log.info("starting", {
    queue: SHOPPING_RUN_QUEUE,
    pollIntervalMs: POLL_INTERVAL_MS,
    sentry: config.sentryDsn ? "dsn set, not wired until WS15" : "off",
  });

  const sql = await connect(config.databaseUrl, controller.signal);
  if (!sql) return;

  try {
    await runPoller({ client: createPgmqClient(sql), log, signal: controller.signal });
  } finally {
    await sql.end({ timeout: 5 });
    log.info("stopped");
  }
}

main().catch((error: unknown) => {
  log.error("fatal", { error: errorMessage(error) });
  process.exitCode = 1;
});
