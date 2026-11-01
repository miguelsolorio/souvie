// The worker's environment. Secrets are read here and nowhere else, and never logged: the
// "starting" line reports only whether each one is set.
import { RETAILER_MODES, type RetailerMode } from "./adapters.ts";
import {
  DEFAULT_HEARTBEAT_SECONDS,
  MAX_HEARTBEAT_SECONDS,
  MIN_HEARTBEAT_SECONDS,
} from "./heartbeat.ts";

export interface WorkerConfig {
  databaseUrl: string;
  /** Runs handled at once. WORKER_CONCURRENCY, 1 to 8, default 2. */
  concurrency: number;
  /** WORKER_HEARTBEAT_SECONDS, 5 to 30 (heartbeat.ts MAX_HEARTBEAT_SECONDS), default 30. */
  heartbeatSeconds: number;
  /** WORKER_RETAILER_MODE: live (default) or mock. Never mock when NODE_ENV is production. */
  retailerMode: RetailerMode;
  anthropicApiKey: string | undefined;
  /** AI_DAILY_CAP_USD, default 2. */
  aiDailyCapUsd: number;
  krogerClientId: string | undefined;
  krogerClientSecret: string | undefined;
  krogerApiBase: string | undefined;
  expoPushAccessToken: string | undefined;
  sentryDsn: string | undefined;
}

function int(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function text(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value ? value : undefined;
}

export function readConfig(env: Record<string, string | undefined>): WorkerConfig {
  const databaseUrl = text(env.WORKER_DATABASE_URL);
  if (!databaseUrl) {
    throw new Error(
      "WORKER_DATABASE_URL is not set. Copy .env.example to .env.local and add the database connection string.",
    );
  }
  const mode = text(env.WORKER_RETAILER_MODE) ?? "live";
  if (!(RETAILER_MODES as readonly string[]).includes(mode)) {
    throw new Error(`WORKER_RETAILER_MODE must be live or mock, not ${mode}`);
  }
  // A mock store fills no real cart: in production it would tell people their cart is ready when
  // nothing is in it.
  if (mode === "mock" && text(env.NODE_ENV) === "production") {
    throw new Error("WORKER_RETAILER_MODE=mock is refused when NODE_ENV is production");
  }
  const cap = Number.parseFloat(env.AI_DAILY_CAP_USD ?? "");
  return {
    databaseUrl,
    concurrency: int(env.WORKER_CONCURRENCY, 2, 1, 8),
    heartbeatSeconds: int(
      env.WORKER_HEARTBEAT_SECONDS,
      DEFAULT_HEARTBEAT_SECONDS,
      MIN_HEARTBEAT_SECONDS,
      MAX_HEARTBEAT_SECONDS,
    ),
    retailerMode: mode as RetailerMode,
    anthropicApiKey: text(env.ANTHROPIC_API_KEY),
    aiDailyCapUsd: Number.isFinite(cap) && cap >= 0 ? cap : 2,
    krogerClientId: text(env.KROGER_CLIENT_ID),
    krogerClientSecret: text(env.KROGER_CLIENT_SECRET),
    krogerApiBase: text(env.KROGER_API_BASE),
    expoPushAccessToken: text(env.EXPO_PUSH_ACCESS_TOKEN),
    sentryDsn: text(env.SENTRY_DSN),
  };
}

/** What the "starting" line may say about the config: shapes, never values. */
export function describeConfig(config: WorkerConfig): Record<string, unknown> {
  return {
    concurrency: config.concurrency,
    heartbeatSeconds: config.heartbeatSeconds,
    retailerMode: config.retailerMode,
    model: config.anthropicApiKey ? "on" : "off (code picks close calls)",
    kroger: config.krogerClientId && config.krogerClientSecret ? "configured" : "not configured",
    push: config.expoPushAccessToken ? "expo with access token" : "expo",
    sentry: config.sentryDsn ? "dsn set, not wired until WS15" : "off",
  };
}
