// Acceptance criterion 1 (the worker half): an event carries no email, token or cookie. The same
// cases run against the app's and the Edge Functions' copies of the scrubber
// (apps/mobile/src/observability/scrub.ts, supabase/functions/_shared/scrub.ts), so the three
// cannot drift apart.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as appScrub from "../../../../apps/mobile/src/observability/scrub.ts";
import * as functionsScrub from "../../../../supabase/functions/_shared/scrub.ts";
import {
  FILTERED,
  scrubBreadcrumb,
  scrubEvent,
  scrubSpan,
  scrubSpanData,
  scrubString,
  scrubValue,
} from "./scrub.ts";

describe("the three copies", () => {
  it("hold the same code, whatever their header comments say", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const body = (path: string) =>
      readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => !line.startsWith("//"))
        .join("\n");
    const worker = body(join(here, "scrub.ts"));
    expect(body(join(here, "../../../../apps/mobile/src/observability/scrub.ts"))).toBe(worker);
    expect(body(join(here, "../../../../supabase/functions/_shared/scrub.ts"))).toBe(worker);
  });
});

const IMPLEMENTATIONS = [
  [
    "worker",
    { scrubString, scrubValue, scrubEvent, scrubSpan, scrubSpanData, scrubBreadcrumb, FILTERED },
  ],
  ["app", appScrub],
  ["functions", functionsScrub],
] as const;

describe.each(IMPLEMENTATIONS)("the %s scrubber", (_name, s) => {
  it("removes emails, bearer tokens, JWTs and known key shapes from a string", () => {
    const text = [
      "user miguel.solorio07@gmail.com signed in",
      "Authorization: Bearer abcdef0123456789abcdef",
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      "key sk-ant-api03-abcdefghijklmnop and sbp_0123456789abcdefghij",
      "push ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx] posthog phc_abcdefghijklmnopqrstuv",
    ].join("\n");
    const out = s.scrubString(text);
    expect(out).not.toMatch(/gmail\.com|solorio/);
    expect(out).not.toMatch(/abcdef0123456789abcdef/);
    expect(out).not.toMatch(/eyJ/);
    expect(out).not.toMatch(/sk-ant|sbp_|phc_|ExponentPushToken\[x/);
    expect(out).toContain(s.FILTERED);
    expect(out).toContain("signed in");
  });

  it("removes a database URL, a DSN and the values of a query string", () => {
    const out = s.scrubString(
      "connect postgres://postgres:hunter2@db.example.test:5432/postgres failed; dsn https://abc123def456@o4500.ingest.us.sentry.io/4505 ; GET https://api.example.test/cb?code=SECRETCODE&state=xyz",
    );
    expect(out).not.toMatch(/hunter2|abc123def456|SECRETCODE|state=xyz/);
    expect(out).toContain("code=[Filtered]");
  });

  it("leaves ids, counts and plain sentences alone", () => {
    const text =
      "run 5a000000-0000-4000-8000-0000000000a1 failed after 3 attempts: quota reached (9500 of 10000)";
    expect(s.scrubString(text)).toBe(text);
  });

  it("filters sensitive keys at any depth, and keeps the ids and counts", () => {
    const out = s.scrubValue({
      household_id: "0a000000-0000-4000-8000-00000000000a",
      input_tokens: 1200,
      max_tokens: 4096,
      attempts: 3,
      password: "hunter2",
      refresh_token: "r-abc",
      accessToken: "a-abc",
      client_secret: "shh",
      Authorization: "Bearer zzzzzzzzzzzz",
      cookie: "sb=1",
      nested: { api_key: "k", email: "a@b.test", user_email: "a@b.test", list: [{ token: "t" }] },
    }) as Record<string, unknown>;
    expect(out).toEqual({
      household_id: "0a000000-0000-4000-8000-00000000000a",
      input_tokens: 1200,
      max_tokens: 4096,
      attempts: 3,
      password: s.FILTERED,
      refresh_token: s.FILTERED,
      accessToken: s.FILTERED,
      client_secret: s.FILTERED,
      Authorization: s.FILTERED,
      cookie: s.FILTERED,
      nested: {
        api_key: s.FILTERED,
        email: s.FILTERED,
        user_email: s.FILTERED,
        list: [{ token: s.FILTERED }],
      },
    });
  });

  it("stops at a bounded depth instead of walking a cycle-sized structure", () => {
    let deep: Record<string, unknown> = { leaf: "x" };
    for (let i = 0; i < 20; i++) deep = { next: deep };
    expect(JSON.stringify(s.scrubValue(deep))).toContain(s.FILTERED);
  });

  it("scrubs a whole event: no user, request body, headers, cookies, query string or host", () => {
    const event = {
      message: "run_stalled for miguel.solorio07@gmail.com",
      user: { id: "u1", email: "miguel.solorio07@gmail.com", ip_address: "1.2.3.4" },
      server_name: "miguels-macbook.local",
      request: {
        url: "https://api.example.test/hook?token=abc&x=1",
        method: "POST",
        headers: { authorization: "Bearer abcdefghijkl", cookie: "sb-access=zzz" },
        cookies: { sb: "zzz" },
        data: { email: "a@b.test" },
        query_string: "token=abc",
      },
      tags: { household_id: "0a000000-0000-4000-8000-00000000000a", release: "abc1234" },
      extra: { token: "t", note: "mail a@b.test" },
      contexts: { runtime: { name: "node" }, secrets: { api_key: "k" } },
      breadcrumbs: [{ message: "GET /x?code=1", data: { authorization: "Bearer abcdefghijkl" } }],
      exception: {
        values: [{ type: "Error", value: "failed for a@b.test with Bearer abcdefghijkl" }],
      },
    };
    const out = s.scrubEvent(event) as typeof event;
    const json = JSON.stringify(out);
    expect(json).not.toMatch(
      /gmail\.com|a@b\.test|abcdefghijkl|sb-access|1\.2\.3\.4|macbook|token=abc|code=1/,
    );
    expect(out).not.toHaveProperty("user");
    expect(out).not.toHaveProperty("server_name");
    expect(out.request).toEqual({
      method: "POST",
      url: "https://api.example.test/hook",
    });
    expect(out.tags).toEqual(event.tags);
    expect(out.exception.values[0]?.type).toBe("Error");
  });

  it("scrubs breadcrumbs in the { values } form too", () => {
    const out = s.scrubEvent({
      breadcrumbs: { values: [{ message: "mail a@b.test" }] },
    }) as { breadcrumbs: { values: Array<{ message: string }> } };
    expect(out.breadcrumbs.values[0]?.message).not.toContain("a@b.test");
  });

  it("removes US phone numbers in the usual formats, and leaves longer digit runs alone", () => {
    const phones = [
      "(555) 123-4567",
      "555-123-4567",
      "555.123.4567",
      "555 123 4567",
      "+1 555 123 4567",
      "+1 (555) 123-4567",
      "1-555-123-4567",
      "5551234567",
    ];
    for (const phone of phones) {
      const out = s.scrubString(`call ${phone} today`);
      expect(out, phone).not.toMatch(/555/);
      expect(out, phone).toBe(`call ${s.FILTERED} today`);
    }
    const kept =
      "run 5a000000-0000-4000-8000-0000000000a1 order 20261031190000 at 1793517648634 upc 0001111041700 total 9500 of 10000 on 2026-11-01T07:20:48Z";
    expect(s.scrubString(kept)).toBe(kept);
  });

  it("removes Cookie and Set-Cookie header lines inside a string, and nothing around them", () => {
    const out = s.scrubString(
      "GET /x\nCookie: sb-access=zzz; theme=dark\nSet-Cookie: sb-refresh=yyy; Path=/; HttpOnly\nHost: api.example.test",
    );
    expect(out).not.toMatch(/zzz|yyy|theme=dark|HttpOnly|sb-refresh/);
    expect(out).toContain(`Cookie: ${s.FILTERED}`);
    expect(out).toContain("GET /x");
    expect(out).toContain("Host: api.example.test");
  });

  it("removes Basic credentials", () => {
    const out = s.scrubString("Authorization: Basic dXNlcjpwYXNzd29yZA== sent");
    expect(out).not.toContain("dXNlcjpwYXNz");
    expect(out).toContain(`Basic ${s.FILTERED}`);
    expect(out).toContain("sent");
  });

  it("filters a whole query string under a key named query, whatever its first parameter is", () => {
    const out = s.scrubValue({
      "url.query": "filter.term=oat+milk&filter.locationId=01400943",
      query_string: "term=oat",
      queryString: "q=1",
      query: "x=1",
      queries: 3,
      status_code: 200,
    });
    expect(out).toEqual({
      "url.query": s.FILTERED,
      query_string: s.FILTERED,
      queryString: s.FILTERED,
      query: s.FILTERED,
      queries: 3,
      status_code: 200,
    });
  });

  it("keeps a span's method, status code, scheme and host, and drops the rest of url.* and http.*", () => {
    const out = s.scrubSpanData({
      "http.request.method": "GET",
      "http.response.status_code": 200,
      "url.full": "https://user:pw@api.example.test/v1/products?filter.term=oat+milk#frag",
      "url.query": "filter.term=oat+milk",
      "url.path": "/v1/products",
      "url.fragment": "frag",
      "url.scheme": "https",
      "url.domain": "api.example.test",
      "http.url": "https://api.example.test/p?x=1",
      "http.target": "/v1/products?filter.term=oat+milk",
      "http.request.header.authorization": ["Bearer abcdefghij"],
      "http.response.header.set-cookie": ["sb=1"],
      "server.address": "api.example.test",
      "server.port": 443,
      "client.address": "1.2.3.4",
      "network.peer.address": "1.2.3.4",
      "sentry.op": "http.client",
    });
    expect(out).toEqual({
      "http.request.method": "GET",
      "http.response.status_code": 200,
      "url.full": "https://api.example.test/v1/products",
      "url.scheme": "https",
      "url.domain": "api.example.test",
      "http.url": "https://api.example.test/p",
      "server.address": "api.example.test",
      "server.port": 443,
      "sentry.op": "http.client",
    });
  });

  it("scrubs a transaction: its spans, its root span's attributes, its name and its breadcrumbs", () => {
    const term = "filter.term=oat+milk+for+Dana";
    const out = s.scrubEvent({
      type: "transaction",
      transaction: `GET /v1/products?${term}`,
      contexts: {
        trace: {
          op: "queue.process",
          data: { "url.query": term, "http.response.status_code": 200 },
        },
      },
      spans: [
        {
          op: "http.client",
          description: `GET https://api.example.test/v1/products?${term}`,
          data: {
            "url.full": `https://api.example.test/v1/products?${term}`,
            "url.query": term,
            "http.response.status_code": 200,
          },
        },
      ],
      breadcrumbs: [
        {
          category: "http",
          data: {
            url: `https://api.example.test/v1/products?${term}`,
            "url.query": term,
            status_code: 200,
          },
        },
      ],
    }) as {
      transaction: string;
      contexts: { trace: { data: Record<string, unknown> } };
      spans: Array<{ description: string; data: Record<string, unknown> }>;
      breadcrumbs: Array<{ data: Record<string, unknown> }>;
    };
    expect(JSON.stringify(out)).not.toMatch(/Dana|oat\+milk|filter\.term=oat/);
    expect(out.contexts.trace.data).toEqual({ "http.response.status_code": 200 });
    expect(out.spans[0]?.data).toEqual({
      "url.full": "https://api.example.test/v1/products",
      "http.response.status_code": 200,
    });
    expect(out.breadcrumbs[0]?.data).toEqual({
      url: "https://api.example.test/v1/products",
      status_code: 200,
    });
  });

  it("scrubs a breadcrumb and a span on their own, as the SDK's hooks call them", () => {
    const crumb = s.scrubBreadcrumb({
      category: "fetch",
      message: "mail a@b.test",
      data: { "url.query": "term=oat", status_code: 200 },
    }) as { message: string; data: Record<string, unknown> };
    expect(crumb.message).not.toContain("a@b.test");
    expect(crumb.data).toEqual({ status_code: 200 });
    const span = s.scrubSpan({
      op: "http.client",
      description: "GET https://api.example.test/p?term=oat",
      data: { "url.query": "term=oat", "http.response.status_code": 200 },
    }) as { description: string; data: Record<string, unknown> };
    expect(span.description).toBe(`GET https://api.example.test/p?term=${s.FILTERED}`);
    expect(span.data).toEqual({ "http.response.status_code": 200 });
  });

  it("does not mutate the event it was given", () => {
    const event = { user: { email: "a@b.test" }, extra: { token: "t" } };
    s.scrubEvent(event);
    expect(event).toEqual({ user: { email: "a@b.test" }, extra: { token: "t" } });
  });
});
