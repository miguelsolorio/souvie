// Edge Function error reports (WS15): off without a DSN, one POST to the envelope endpoint with it,
// scrubbed, tagged with the function and the household, and never a reason to fail a response.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEdgeReporter,
  edgeReporter,
  parseDsn,
  parseStack,
  reportError,
  setEdgeReporterForTests,
} from "./sentry.ts";

const DSN = "https://abc123publickey@o4500.ingest.us.sentry.io/4505";
const HOUSEHOLD = "0a000000-0000-4000-8000-00000000000a";

function posting() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const doFetch = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { doFetch, calls };
}

afterEach(() => setEdgeReporterForTests(undefined));

describe("parseDsn", () => {
  it("reads the key, host and project", () => {
    expect(parseDsn(DSN)).toEqual({
      publicKey: "abc123publickey",
      host: "o4500.ingest.us.sentry.io",
      projectId: "4505",
      protocol: "https",
    });
  });

  it("is null for anything that is not a DSN", () => {
    for (const bad of [
      undefined,
      "",
      "  ",
      "nope",
      "https://o4500.ingest.sentry.io/4505",
      "https://k@host/abc",
      "ftp://k@host/1",
    ]) {
      expect(parseDsn(bad), String(bad)).toBeNull();
    }
  });
});

describe("parseStack", () => {
  it("turns a V8 stack into frames, oldest call first", () => {
    const frames = parseStack(
      [
        "Error: boom",
        "    at inner (file:///src/functions/suggest/handler.ts:172:5)",
        "    at file:///src/functions/suggest/index.ts:99:12",
        "    at ext:deno_node/x.ts:1:1",
        "    at dep (file:///node_modules/zod/index.js:3:4)",
      ].join("\n"),
    );
    expect(frames.map((f) => [f.function, f.lineno, f.in_app])).toEqual([
      ["dep", 3, false],
      ["<anonymous>", 1, false],
      ["<anonymous>", 99, true],
      ["inner", 172, true],
    ]);
    expect(parseStack(undefined)).toEqual([]);
  });
});

describe("createEdgeReporter", () => {
  it("does nothing without a DSN", () => {
    const { doFetch, calls } = posting();
    const reporter = createEdgeReporter({ fetch: doFetch });
    expect(reporter.enabled).toBe(false);
    reporter.captureException(new Error("x"), { function: "suggest" });
    expect(calls).toEqual([]);
    expect(createEdgeReporter({ dsn: "not a dsn", fetch: doFetch }).enabled).toBe(false);
  });

  it("posts one envelope with the function, household and release, and the key in a header", async () => {
    const { doFetch, calls } = posting();
    const waited: Promise<unknown>[] = [];
    const reporter = createEdgeReporter({
      dsn: DSN,
      release: "9f8e7d6c",
      environment: "production",
      fetch: doFetch,
      waitUntil: (p) => waited.push(p),
      now: () => new Date("2026-10-31T12:00:00Z"),
      newId: () => "0123456789abcdef0123456789abcdef",
    });
    reporter.captureException(new TypeError("bad input"), {
      function: "suggest",
      householdId: HOUSEHOLD,
    });
    await Promise.all(waited);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://o4500.ingest.us.sentry.io/api/4505/envelope/");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["X-Sentry-Auth"]).toContain("sentry_key=abc123publickey");
    expect(headers["Content-Type"]).toBe("application/x-sentry-envelope");

    const [envelopeHeader, itemHeader, payload] = String(calls[0]?.init.body)
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(envelopeHeader).toEqual({
      event_id: "0123456789abcdef0123456789abcdef",
      sent_at: "2026-10-31T12:00:00.000Z",
    });
    expect(itemHeader).toEqual({ type: "event" });
    expect(payload).toMatchObject({
      level: "error",
      release: "9f8e7d6c",
      environment: "production",
      tags: { function: "suggest", household_id: HOUSEHOLD, runtime: "edge" },
      exception: { values: [{ type: "TypeError", value: "bad input" }] },
    });
    // The DSN's key is in the header only, never in the body.
    expect(String(calls[0]?.init.body)).not.toContain("abc123publickey");
  });

  it("scrubs the message and sends no user, request or host", async () => {
    const { doFetch, calls } = posting();
    const waited: Promise<unknown>[] = [];
    const reporter = createEdgeReporter({
      dsn: DSN,
      fetch: doFetch,
      waitUntil: (p) => waited.push(p),
    });
    reporter.captureException(
      new Error(
        "sign-in failed for miguel@example.test with Bearer abcdefghijklmnop at https://x.test/cb?code=SECRET",
      ),
      { function: "recipe-import" },
    );
    await Promise.all(waited);
    const body = String(calls[0]?.init.body);
    expect(body).not.toMatch(/miguel@example|abcdefghijklmnop|SECRET/);
    expect(body).toContain("sign-in failed for [Filtered]");
    const payload = JSON.parse(body.split("\n")[2] as string);
    expect(payload).not.toHaveProperty("user");
    expect(payload).not.toHaveProperty("request");
    expect(payload).not.toHaveProperty("server_name");
  });

  it("wraps a non-error and survives a failing network, a throwing fetch and a throwing waitUntil", async () => {
    const down = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const waited: Promise<unknown>[] = [];
    const reporter = createEdgeReporter({
      dsn: DSN,
      fetch: down,
      waitUntil: (p) => waited.push(p),
    });
    expect(() => reporter.captureException("a string", { function: "x" })).not.toThrow();
    await expect(Promise.all(waited)).resolves.toBeDefined();

    const throwingFetch = (() => {
      throw new Error("sync throw");
    }) as unknown as typeof fetch;
    expect(() =>
      createEdgeReporter({ dsn: DSN, fetch: throwingFetch }).captureException(new Error("x"), {
        function: "x",
      }),
    ).not.toThrow();
    const noWait = createEdgeReporter({
      dsn: DSN,
      fetch: posting().doFetch,
      waitUntil: () => {
        throw new Error("no runtime");
      },
    });
    expect(() => noWait.captureException(new Error("x"), { function: "x" })).not.toThrow();
  });
});

describe("the isolate's reporter", () => {
  it("is off in Node, where there is no Deno environment", () => {
    expect(edgeReporter().enabled).toBe(false);
    expect(() => reportError(new Error("x"), { function: "suggest" })).not.toThrow();
  });

  it("reportError goes to the reporter that was set", () => {
    const captureException = vi.fn();
    setEdgeReporterForTests({ enabled: true, captureException });
    const error = new Error("boom");
    reportError(error, { function: "llm-proxy", householdId: HOUSEHOLD });
    expect(captureException).toHaveBeenCalledWith(error, {
      function: "llm-proxy",
      householdId: HOUSEHOLD,
    });
  });
});
