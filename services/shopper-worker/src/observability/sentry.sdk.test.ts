// The real @sentry/node SDK, started the way createSentryReporter starts it (same options), with a
// transport of our own that keeps what would be sent. The review of WS15 found that spans shipped
// the query string of an outbound request, search term included: @sentry/node 11 defaults to the
// 'stream' trace lifecycle, which ignores beforeSendTransaction, and even with the static
// lifecycle scrubEvent did not look at span attributes. This test would have caught both.
//
// It makes a real request to a server on localhost with a search term in the query, inside a
// traced run, and then looks at every envelope the SDK handed to the transport.
import http from "node:http";
import type { AddressInfo } from "node:net";
import * as Sentry from "@sentry/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSentryReporter, type ErrorReporter, type SentryLike } from "./sentry.ts";

const HOUSEHOLD = "0a000000-0000-4000-8000-00000000000a";
const RUN = "5a000000-0000-4000-8000-0000000000a1";

interface Sent {
  type: string;
  payload: Record<string, unknown>;
}

const sent: Sent[] = [];
let server: http.Server;
let reporter: ErrorReporter;

/** The transport the SDK gets instead of the network. */
function memoryTransport() {
  return {
    async send(envelope: [unknown, Array<[{ type?: string }, Record<string, unknown>]>]) {
      for (const [header, payload] of envelope[1]) {
        sent.push({ type: header.type ?? "", payload });
      }
      return { statusCode: 200 };
    },
    async flush() {
      return true;
    },
  };
}

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const sdk = {
    ...Sentry,
    init: (options: Record<string, unknown>) =>
      Sentry.init({ ...options, transport: memoryTransport } as Parameters<typeof Sentry.init>[0]),
  } as unknown as SentryLike;
  reporter = await createSentryReporter(
    { SENTRY_DSN: "https://publickey@o1.ingest.sentry.io/1", SENTRY_RELEASE: "test-sha" },
    { sdk },
  );
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}/v1/products?filter.term=oat+milk+for+Dana&filter.locationId=01400943`;
  await reporter.traceRun("shopping_run", { householdId: HOUSEHOLD, runId: RUN }, async () => {
    const response = await fetch(url);
    await response.text();
  });
  // A run the worker marks failed: README alert rule 3 (Transactions, failure_rate()) counts it.
  await reporter.traceRun("shopping_run", { householdId: HOUSEHOLD, runId: RUN }, async (span) => {
    span.fail("kroger_503");
  });
  await reporter.flush(3000);
}, 30_000);

afterAll(async () => {
  await Sentry.close(2000);
  await new Promise((resolve) => server?.close(resolve));
});

const transactions = () => sent.filter((item) => item.type === "transaction").map((i) => i.payload);

describe("the worker's Sentry options on the real SDK", () => {
  it("starts with the static trace lifecycle, so beforeSendTransaction and beforeSendSpan run", () => {
    expect(reporter.enabled).toBe(true);
    expect(Sentry.getClient()?.getOptions().traceLifecycle).toBe("static");
  });

  it("sends the traced run and the outbound request as spans", () => {
    const run = transactions().find((t) => t.transaction === "shopping_run");
    expect(run).toBeDefined();
    const spans = (run?.spans ?? []) as Array<{ op?: string; data?: Record<string, unknown> }>;
    const request = spans.find((span) => span.op === "http.client");
    expect(request).toBeDefined();
    // What stays: the method, the status code and the host.
    expect(request?.data).toMatchObject({
      "http.request.method": "GET",
      "http.response.status_code": 200,
      "server.address": "127.0.0.1",
    });
  });

  it("puts no query string, no search term and no peer address in any span or transaction", () => {
    expect(transactions().length).toBeGreaterThanOrEqual(2);
    const everything = JSON.stringify(sent);
    expect(everything).not.toMatch(/Dana|oat\+milk|oat%20milk|oat milk|filter\.term/);
    expect(everything).not.toMatch(/01400943|query_string/);

    for (const transaction of transactions()) {
      const attributes: Array<Record<string, unknown>> = [
        (transaction.contexts as { trace?: { data?: Record<string, unknown> } }).trace?.data ?? {},
        ...((transaction.spans ?? []) as Array<{ data?: Record<string, unknown> }>).map(
          (span) => span.data ?? {},
        ),
      ];
      for (const data of attributes) {
        for (const [key, value] of Object.entries(data)) {
          expect(key).not.toMatch(/^(url\.(query|path|fragment)|http\.(target|query|url))$/);
          expect(key).not.toMatch(/^http\.(request|response)\.header\./);
          expect(key).not.toMatch(/^(client\.|network\.(peer|local)\.)/);
          if (/^url(\.full)?$/.test(key)) expect(String(value)).not.toMatch(/[?#]/);
        }
      }
    }
  });

  it("keeps the run's tags on its transaction", () => {
    const run = transactions().find((t) => t.transaction === "shopping_run");
    expect(run?.tags).toMatchObject({ household_id: HOUSEHOLD, run_id: RUN });
    expect(run?.release).toBe("test-sha");
  });

  it("sends each run as a transaction whose status the failure rate counts (README alert rule 3)", () => {
    const runs = transactions().filter((t) => t.transaction === "shopping_run");
    const statuses = runs.map(
      (t) => (t.contexts as { trace: { status?: string } }).trace.status ?? "unknown",
    );
    expect(statuses).toHaveLength(2);
    expect(statuses.filter((status) => status === "ok")).toHaveLength(1);
    expect(statuses.filter((status) => status !== "ok")).toEqual(["internal_error"]);
    // The Transactions dataset is what `transaction:shopping_run` queries; 'stream' fills the
    // Spans dataset instead.
    for (const t of runs) expect(t.type).toBe("transaction");
  });
});
