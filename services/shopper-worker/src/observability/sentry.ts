// Sentry in the worker (WS15): @sentry/node behind a small `ErrorReporter`, so the rest of the
// worker (and its tests) never import the SDK. Without SENTRY_DSN the reporter does nothing and
// the SDK is never loaded.
//
// What an event carries: the release (the git SHA the image was built from), the environment, a
// `household_id` tag and a `run_id` tag when the failure belongs to a run, and the stack. Nothing
// about a person: `scrubEvent` runs in beforeSend and beforeSendTransaction and removes the user,
// the request body, headers and cookies, query strings, and every email, token, key and URL with
// credentials, from every string (scrub.ts). The worker never sends a prompt, a model answer, a
// recipe or a list: callers pass ids and counts as `extra`.
import { scrubEvent, scrubValue } from "./scrub.ts";

export interface EventContext {
  householdId?: string | null | undefined;
  runId?: string | null | undefined;
  level?: "info" | "warning" | "error";
  tags?: Record<string, string>;
  /** Ids, counts and short codes. Scrubbed again before it is sent. */
  extra?: Record<string, unknown>;
  fingerprint?: string[];
}

/** What a unit of work can tell its transaction. */
export interface RunSpan {
  /** Marks the transaction failed, so Sentry's failure rate counts it. */
  fail(reason: string): void;
}

export interface ErrorReporter {
  readonly enabled: boolean;
  captureException(error: unknown, context?: EventContext): void;
  /** A named event with no exception: run_stalled, run_dead_lettered, run_failed. */
  captureEvent(name: string, context?: EventContext): void;
  /** A Sentry Cron Monitor check-in: the worker is alive. A missed one raises an issue. */
  checkIn(status: "in_progress" | "ok" | "error"): void;
  /** One unit of work as a transaction, so Sentry can compute the failure rate for the 5% alert. */
  traceRun<T>(name: string, context: EventContext, work: (span: RunSpan) => Promise<T>): Promise<T>;
  flush(timeoutMs?: number): Promise<void>;
}

/** The monitor the check-ins belong to. Its alert rule is in README.md. */
export const MONITOR_SLUG = "shopper-worker";

export const noopReporter: ErrorReporter = {
  enabled: false,
  captureException() {},
  captureEvent() {},
  checkIn() {},
  traceRun: (_name, _context, work) => work({ fail() {} }),
  async flush() {},
};

/** The slice of @sentry/node this file uses. */
export interface SentryLike {
  init(options: Record<string, unknown>): unknown;
  captureException(error: unknown, captureContext?: Record<string, unknown>): string;
  captureEvent(event: Record<string, unknown>): string;
  captureCheckIn(checkIn: Record<string, unknown>, monitorConfig?: Record<string, unknown>): string;
  withScope<T>(callback: (scope: { setTag(key: string, value: string): void }) => T): T;
  startSpan<T>(
    options: Record<string, unknown>,
    callback: (span: {
      setStatus(status: { code: number; message?: string }): void;
      setAttribute(key: string, value: string | number | boolean): void;
    }) => T,
  ): T;
  flush(timeoutMs?: number): Promise<boolean>;
}

export interface SentryEnv {
  SENTRY_DSN?: string | undefined;
  SENTRY_ENVIRONMENT?: string | undefined;
  SENTRY_RELEASE?: string | undefined;
  GIT_SHA?: string | undefined;
  RAILWAY_GIT_COMMIT_SHA?: string | undefined;
  NODE_ENV?: string | undefined;
}

/** The release is the git SHA the image was built from (Dockerfile ARG GIT_SHA). */
export function releaseOf(env: SentryEnv): string | undefined {
  const value = (env.SENTRY_RELEASE ?? env.GIT_SHA ?? env.RAILWAY_GIT_COMMIT_SHA)?.trim();
  return value ? value : undefined;
}

/** @sentry/core's SPAN_STATUS_ERROR. */
const SPAN_STATUS_ERROR = 2;

export function tagsOf(context: EventContext | undefined, extraTags: Record<string, string> = {}) {
  const tags: Record<string, string> = { ...extraTags, ...(context?.tags ?? {}) };
  if (context?.householdId) tags.household_id = context.householdId;
  if (context?.runId) tags.run_id = context.runId;
  return tags;
}

/** A reporter over an initialized SDK. `init` is the caller's job; see `createSentryReporter`. */
export function reporterOver(sdk: SentryLike): ErrorReporter {
  const scrubbedExtra = (context?: EventContext) =>
    context?.extra ? (scrubValue(context.extra) as Record<string, unknown>) : undefined;

  return {
    enabled: true,
    captureException(error, context) {
      const extra = scrubbedExtra(context);
      sdk.captureException(error, {
        tags: tagsOf(context),
        ...(extra ? { extra } : {}),
        ...(context?.level ? { level: context.level } : {}),
        ...(context?.fingerprint ? { fingerprint: context.fingerprint } : {}),
      });
    },
    captureEvent(name, context) {
      const extra = scrubbedExtra(context);
      sdk.captureEvent({
        message: name,
        level: context?.level ?? "error",
        tags: tagsOf(context, { event: name }),
        ...(extra ? { extra } : {}),
        fingerprint: context?.fingerprint ?? [name, context?.runId ?? "none"],
      });
    },
    checkIn(status) {
      sdk.captureCheckIn(
        { monitorSlug: MONITOR_SLUG, status },
        {
          schedule: { type: "interval", value: 1, unit: "minute" },
          checkinMargin: 4,
          maxRuntime: 60 * 24,
          timezone: "UTC",
          failureIssueThreshold: 1,
          recoveryThreshold: 1,
        },
      );
    },
    traceRun(name, context, work) {
      return sdk.withScope((scope) => {
        for (const [key, value] of Object.entries(tagsOf(context))) scope.setTag(key, value);
        return sdk.startSpan(
          { name, op: "queue.process", forceTransaction: true },
          async (span) => {
            try {
              const result = await work({
                fail: (reason) => span.setStatus({ code: SPAN_STATUS_ERROR, message: reason }),
              });
              return result;
            } catch (error) {
              span.setStatus({ code: SPAN_STATUS_ERROR, message: "internal_error" });
              throw error;
            }
          },
        );
      });
    },
    async flush(timeoutMs = 2000) {
      await sdk.flush(timeoutMs);
    },
  };
}

export interface CreateSentryOptions {
  /** Replaces `import("@sentry/node")`, for a test. */
  sdk?: SentryLike;
  onWarning?: (message: string) => void;
}

/**
 * Initializes @sentry/node when SENTRY_DSN is set and returns the reporter; with no DSN, or if the
 * SDK cannot start, returns the no-op reporter. Never throws.
 */
export async function createSentryReporter(
  env: SentryEnv,
  options: CreateSentryOptions = {},
): Promise<ErrorReporter> {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return noopReporter;
  try {
    const sdk = options.sdk ?? ((await import("@sentry/node")) as unknown as SentryLike);
    const release = releaseOf(env);
    sdk.init({
      dsn,
      ...(release ? { release } : {}),
      environment: env.SENTRY_ENVIRONMENT?.trim() || env.NODE_ENV || "development",
      // No IP, no cookies, no request bodies: this is a worker with no end users.
      sendDefaultPii: false,
      // Volume is one transaction per run phase, so every one is kept.
      tracesSampleRate: 1,
      maxBreadcrumbs: 30,
      beforeSend: (event: Record<string, unknown>) => scrubEvent(event),
      beforeSendTransaction: (event: Record<string, unknown>) => scrubEvent(event),
      beforeBreadcrumb: (breadcrumb: Record<string, unknown>) =>
        scrubValue(breadcrumb) as Record<string, unknown>,
    });
    return reporterOver(sdk);
  } catch (error) {
    options.onWarning?.(
      `sentry could not start: ${error instanceof Error ? error.message : String(error)}`,
    );
    return noopReporter;
  }
}
