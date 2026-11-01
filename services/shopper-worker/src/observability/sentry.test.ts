// Acceptance criterion 1 (the worker half): events carry the release and the household_id tag and
// no email, token or cookie. The SDK is a fake here; the real one is loaded only when a DSN is set.
import { describe, expect, it, vi } from "vitest";
import {
  createSentryReporter,
  MONITOR_SLUG,
  noopReporter,
  releaseOf,
  reporterOver,
  type SentryLike,
} from "./sentry.ts";

function fakeSdk() {
  const calls = {
    init: [] as Array<Record<string, unknown>>,
    exceptions: [] as Array<{ error: unknown; context: Record<string, unknown> | undefined }>,
    events: [] as Array<Record<string, unknown>>,
    checkIns: [] as Array<{ checkIn: Record<string, unknown>; config?: Record<string, unknown> }>,
    spans: [] as Array<{
      options: Record<string, unknown>;
      status?: { code: number; message?: string };
    }>,
    tags: [] as Array<[string, string]>,
    flushed: [] as Array<number | undefined>,
  };
  const sdk: SentryLike = {
    init: (options) => void calls.init.push(options),
    captureException: (error, context) => {
      calls.exceptions.push({ error, context });
      return "id";
    },
    captureEvent: (event) => {
      calls.events.push(event);
      return "id";
    },
    captureCheckIn: (checkIn, config) => {
      calls.checkIns.push({ checkIn, ...(config ? { config } : {}) });
      return "id";
    },
    withScope: (callback) =>
      callback({ setTag: (key, value) => void calls.tags.push([key, value]) }),
    startSpan: (options, callback) => {
      const record: (typeof calls.spans)[number] = { options };
      calls.spans.push(record);
      return callback({
        setStatus: (status) => {
          record.status = status;
        },
        setAttribute: () => {},
      });
    },
    flush: async (ms) => {
      calls.flushed.push(ms);
      return true;
    },
  };
  return { sdk, calls };
}

describe("createSentryReporter", () => {
  it("is off without a DSN: nothing starts and the SDK is never loaded", async () => {
    const { sdk, calls } = fakeSdk();
    const reporter = await createSentryReporter({}, { sdk });
    expect(reporter).toBe(noopReporter);
    expect(reporter.enabled).toBe(false);
    expect(calls.init).toHaveLength(0);
    reporter.captureException(new Error("x"));
    reporter.captureEvent("run_stalled");
    reporter.checkIn("ok");
    await reporter.flush();
    expect(await reporter.traceRun("t", {}, async () => 7)).toBe(7);
    expect(calls.exceptions).toHaveLength(0);
    expect(calls.events).toHaveLength(0);
  });

  it("treats a blank DSN as no DSN", async () => {
    const { sdk, calls } = fakeSdk();
    expect(await createSentryReporter({ SENTRY_DSN: "   " }, { sdk })).toBe(noopReporter);
    expect(calls.init).toHaveLength(0);
  });

  it("initializes with the release, the environment and no default PII", async () => {
    const { sdk, calls } = fakeSdk();
    const reporter = await createSentryReporter(
      {
        SENTRY_DSN: "https://k@o1.ingest.sentry.io/2",
        GIT_SHA: "9f8e7d6c5b4a",
        SENTRY_ENVIRONMENT: "production",
      },
      { sdk },
    );
    expect(reporter.enabled).toBe(true);
    expect(calls.init).toHaveLength(1);
    expect(calls.init[0]).toMatchObject({
      dsn: "https://k@o1.ingest.sentry.io/2",
      release: "9f8e7d6c5b4a",
      environment: "production",
      sendDefaultPii: false,
      tracesSampleRate: 1,
    });
  });

  it("scrubs every event and transaction in beforeSend", async () => {
    const { sdk, calls } = fakeSdk();
    await createSentryReporter({ SENTRY_DSN: "https://k@o1.ingest.sentry.io/2" }, { sdk });
    const options = calls.init[0] as {
      beforeSend: (e: Record<string, unknown>) => Record<string, unknown>;
      beforeSendTransaction: (e: Record<string, unknown>) => Record<string, unknown>;
      beforeBreadcrumb: (b: Record<string, unknown>) => Record<string, unknown>;
    };
    const dirty = {
      user: { email: "a@b.test" },
      request: {
        cookies: { sb: "x" },
        headers: { cookie: "sb=x" },
        url: "https://x.test/?token=1",
      },
      message: "failed for a@b.test",
      tags: { household_id: "0a000000-0000-4000-8000-00000000000a" },
    };
    for (const hook of [options.beforeSend, options.beforeSendTransaction]) {
      const out = hook(dirty);
      expect(JSON.stringify(out)).not.toMatch(/a@b\.test|sb=x|token=1/);
      expect(out.tags).toEqual(dirty.tags);
    }
    expect(JSON.stringify(options.beforeBreadcrumb({ message: "to a@b.test" }))).not.toContain(
      "a@b.test",
    );
  });

  it("falls back to the no-op reporter, with a warning, when the SDK cannot start", async () => {
    const warn = vi.fn();
    const sdk: SentryLike = {
      ...fakeSdk().sdk,
      init: () => {
        throw new Error("bad dsn");
      },
    };
    const reporter = await createSentryReporter({ SENTRY_DSN: "nope" }, { sdk, onWarning: warn });
    expect(reporter).toBe(noopReporter);
    expect(warn).toHaveBeenCalledWith("sentry could not start: bad dsn");
  });
});

describe("releaseOf", () => {
  it("is the git SHA the image was built from", () => {
    expect(releaseOf({ GIT_SHA: " abc123 " })).toBe("abc123");
    expect(releaseOf({ SENTRY_RELEASE: "r1", GIT_SHA: "abc123" })).toBe("r1");
    expect(releaseOf({ RAILWAY_GIT_COMMIT_SHA: "def456" })).toBe("def456");
    expect(releaseOf({})).toBeUndefined();
    expect(releaseOf({ GIT_SHA: "  " })).toBeUndefined();
  });
});

describe("the reporter", () => {
  const HOUSEHOLD = "0a000000-0000-4000-8000-00000000000a";
  const RUN = "5a000000-0000-4000-8000-0000000000a1";

  it("tags an exception with the household and the run, and scrubs what it was given", () => {
    const { sdk, calls } = fakeSdk();
    const reporter = reporterOver(sdk);
    const error = new Error("boom");
    reporter.captureException(error, {
      householdId: HOUSEHOLD,
      runId: RUN,
      level: "warning",
      tags: { attempt: "2" },
      extra: { msg_id: "7", refresh_token: "r-secret", note: "mail a@b.test" },
    });
    expect(calls.exceptions).toHaveLength(1);
    expect(calls.exceptions[0]?.error).toBe(error);
    expect(calls.exceptions[0]?.context).toEqual({
      tags: { attempt: "2", household_id: HOUSEHOLD, run_id: RUN },
      extra: { msg_id: "7", refresh_token: "[Filtered]", note: "mail [Filtered]" },
      level: "warning",
    });
  });

  it("sends a named event with the name as the message and as a tag", () => {
    const { sdk, calls } = fakeSdk();
    reporterOver(sdk).captureEvent("run_stalled", {
      householdId: HOUSEHOLD,
      runId: RUN,
      tags: { reason: "no_worker" },
      extra: { silent_seconds: 700 },
    });
    expect(calls.events[0]).toEqual({
      message: "run_stalled",
      level: "error",
      tags: { event: "run_stalled", reason: "no_worker", household_id: HOUSEHOLD, run_id: RUN },
      extra: { silent_seconds: 700 },
      fingerprint: ["run_stalled", RUN],
    });
  });

  it("checks in to the cron monitor, expecting one a minute and tolerating four missed", () => {
    const { sdk, calls } = fakeSdk();
    reporterOver(sdk).checkIn("ok");
    expect(calls.checkIns[0]?.checkIn).toEqual({ monitorSlug: MONITOR_SLUG, status: "ok" });
    expect(calls.checkIns[0]?.config).toMatchObject({
      schedule: { type: "interval", value: 1, unit: "minute" },
      checkinMargin: 4,
    });
  });

  it("runs a unit of work as a transaction tagged with the run, and marks a failure", async () => {
    const { sdk, calls } = fakeSdk();
    const reporter = reporterOver(sdk);
    const ok = await reporter.traceRun(
      "shopping_run",
      { householdId: HOUSEHOLD, runId: RUN },
      async () => "done",
    );
    expect(ok).toBe("done");
    expect(calls.tags).toEqual([
      ["household_id", HOUSEHOLD],
      ["run_id", RUN],
    ]);
    expect(calls.spans[0]?.options).toMatchObject({
      name: "shopping_run",
      op: "queue.process",
      forceTransaction: true,
    });
    expect(calls.spans[0]?.status).toBeUndefined();

    await reporter.traceRun("shopping_run", {}, async (span) => span.fail("needs_reauth"));
    expect(calls.spans[1]?.status).toEqual({ code: 2, message: "needs_reauth" });

    await expect(
      reporter.traceRun("shopping_run", {}, async () => {
        throw new Error("db down");
      }),
    ).rejects.toThrow("db down");
    expect(calls.spans[2]?.status).toEqual({ code: 2, message: "internal_error" });
  });

  it("flushes with a timeout", async () => {
    const { sdk, calls } = fakeSdk();
    await reporterOver(sdk).flush(1500);
    expect(calls.flushed).toEqual([1500]);
  });
});
