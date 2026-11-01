// Acceptance criterion 1 (the app half): Sentry starts only with a DSN, tags events with the
// release (the git SHA) and the household, and sends no email, token or cookie.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  init: vi.fn(),
  setTag: vi.fn(),
  setUser: vi.fn(),
  captureException: vi.fn(),
}));
vi.mock("@sentry/react-native", () => sdk);

const env = vi.hoisted(() => ({
  publicEnv: {
    sentryDsn: undefined as string | undefined,
    gitSha: undefined as string | undefined,
    sentryEnvironment: undefined as string | undefined,
    posthogKey: undefined as string | undefined,
    posthogHost: undefined as string | undefined,
  },
}));
vi.mock("../lib/env", () => env);

import { sentryInitOptions } from "./sentryOptions";

beforeEach(() => {
  vi.resetModules();
  for (const fn of Object.values(sdk)) fn.mockReset();
  env.publicEnv.sentryDsn = undefined;
  env.publicEnv.gitSha = undefined;
  env.publicEnv.sentryEnvironment = undefined;
  (globalThis as { __DEV__?: boolean }).__DEV__ = true;
});
afterEach(() => {
  (globalThis as { __DEV__?: boolean }).__DEV__ = undefined;
});

describe("sentryInitOptions", () => {
  it("is null without a DSN, so Sentry stays off", () => {
    expect(sentryInitOptions({})).toBeNull();
    expect(sentryInitOptions({ dsn: "   " })).toBeNull();
  });

  it("carries the release and the environment, and asks for no PII, screenshot or tracing", () => {
    const options = sentryInitOptions({
      dsn: "https://k@o1.ingest.sentry.io/2",
      release: " 9f8e7d6c ",
      environment: "staging",
    });
    expect(options).toMatchObject({
      dsn: "https://k@o1.ingest.sentry.io/2",
      release: "9f8e7d6c",
      environment: "staging",
      sendDefaultPii: false,
      tracesSampleRate: 0,
      attachScreenshot: false,
      attachViewHierarchy: false,
    });
  });

  it("defaults the environment from __DEV__, and leaves the release out when there is none", () => {
    const dev = sentryInitOptions({ dsn: "https://k@o1.ingest.sentry.io/2", dev: true });
    expect(dev?.environment).toBe("development");
    expect(dev).not.toHaveProperty("release");
    expect(sentryInitOptions({ dsn: "https://k@o1.ingest.sentry.io/2" })?.environment).toBe(
      "production",
    );
  });

  it("scrubs the event and the breadcrumbs it sends: no email, token or cookie", () => {
    const options = sentryInitOptions({ dsn: "https://k@o1.ingest.sentry.io/2" }) as {
      beforeSend: (e: Record<string, unknown>) => Record<string, unknown>;
      beforeBreadcrumb: (b: Record<string, unknown>) => Record<string, unknown>;
    };
    const event = options.beforeSend({
      user: { email: "miguel@example.test", id: "u1" },
      request: { cookies: { sb: "zzz" }, headers: { authorization: "Bearer abcdefghijkl" } },
      tags: { household_id: "0a000000-0000-4000-8000-00000000000a", release: "9f8e7d6c" },
      exception: { values: [{ type: "Error", value: "sign-in failed for miguel@example.test" }] },
      extra: { access_token: "t-123", note: "ok" },
    });
    const json = JSON.stringify(event);
    expect(json).not.toMatch(/miguel@example|zzz|abcdefghijkl|t-123/);
    expect(event).not.toHaveProperty("user");
    expect(event.tags).toEqual({
      household_id: "0a000000-0000-4000-8000-00000000000a",
      release: "9f8e7d6c",
    });
    expect(
      JSON.stringify(options.beforeBreadcrumb({ message: "to miguel@example.test" })),
    ).not.toContain("miguel@example");
  });
});

describe("the native module", () => {
  it("does not start the SDK without a DSN", async () => {
    const native = await import("./sentry.native");
    expect(native.initSentry()).toBe(false);
    expect(sdk.init).not.toHaveBeenCalled();
    native.setSentryHousehold("0a000000-0000-4000-8000-00000000000a");
    native.captureError(new Error("x"));
    expect(sdk.setTag).not.toHaveBeenCalled();
    expect(sdk.captureException).not.toHaveBeenCalled();
  });

  it("starts once with the build's release, then tags the household and never sets a user", async () => {
    env.publicEnv.sentryDsn = "https://k@o1.ingest.sentry.io/2";
    env.publicEnv.gitSha = "9f8e7d6c";
    const native = await import("./sentry.native");
    expect(native.initSentry()).toBe(true);
    expect(native.initSentry()).toBe(true);
    expect(sdk.init).toHaveBeenCalledTimes(1);
    expect(sdk.init.mock.calls[0]?.[0]).toMatchObject({
      release: "9f8e7d6c",
      sendDefaultPii: false,
    });

    native.setSentryHousehold("0a000000-0000-4000-8000-00000000000a");
    expect(sdk.setTag).toHaveBeenCalledWith("household_id", "0a000000-0000-4000-8000-00000000000a");
    expect(sdk.setUser).toHaveBeenCalledWith(null);
    native.setSentryHousehold(null);
    expect(sdk.setTag).toHaveBeenLastCalledWith("household_id", undefined);

    const error = new Error("boom");
    native.captureError(error);
    expect(sdk.captureException).toHaveBeenCalledWith(error);
  });

  it("stays off if the SDK throws on start", async () => {
    env.publicEnv.sentryDsn = "https://k@o1.ingest.sentry.io/2";
    sdk.init.mockImplementation(() => {
      throw new Error("native module missing");
    });
    const native = await import("./sentry.native");
    expect(native.initSentry()).toBe(false);
  });

  it("the web build's module never starts anything", async () => {
    const web = await import("./sentry");
    expect(web.initSentry()).toBe(false);
    expect(() => web.setSentryHousehold("h")).not.toThrow();
    expect(() => web.captureError(new Error("x"))).not.toThrow();
    expect(sdk.init).not.toHaveBeenCalled();
  });
});
