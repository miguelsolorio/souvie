// WS08 criterion 9: llm-proxy's membership check, cost caps, forwarding with the server key,
// ai_runs logging, and that the key never leaves the function.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import type { AiRunRecord } from "../../../packages/llm/src/log.ts";
import {
  ANTHROPIC_VERSION,
  estimateInputTokens,
  handleLlmProxy,
  MAX_BODY_BYTES,
  type ProxyStore,
  parseProxyRequest,
  type Runtime,
  UsageMeter,
  worstCaseCostUsd,
} from "./handler.ts";
import { createServiceStore, type ServiceDb } from "./store.ts";

// supabase-js is only needed by the real runtime; the tests inject their own.
vi.mock("./client.ts", () => ({ createClient: vi.fn() }));

const SERVER_KEY = "sk-ant-test-server-key-ws08-0123456789";
const HOUSEHOLD = "0a000000-0000-4000-8000-00000000000a";
const OTHER = "0b000000-0000-4000-8000-00000000000b";
const ALICE = "a1111111-1111-4111-8111-111111111111";
const RUN = "5a000000-0000-4000-8000-0000000000a1";

const SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-5-5","content":[],"stop_reason":null,"usage":{"input_tokens":1200,"cache_read_input_tokens":800,"cache_creation_input_tokens":0,"output_tokens":1}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"pong"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

function sseResponse(chunks: string[] = SSE, split = true): Response {
  const encoder = new TextEncoder();
  // Split events across chunk boundaries the way a network does.
  const bytes = encoder.encode(chunks.join(""));
  const parts = split ? [bytes.slice(0, 37), bytes.slice(37, 400), bytes.slice(400)] : [bytes];
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const p of parts) controller.enqueue(p);
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

interface Harness {
  runtime: Runtime;
  rows: { record: AiRunRecord; runId: string | null }[];
  fetch: ReturnType<typeof vi.fn>;
  store: ProxyStore & { spent: number; runSpent: number | null };
}

function harness(
  opts: {
    member?: boolean;
    spent?: number;
    runSpent?: number | null;
    upstream?: () => Response | Promise<Response>;
    key?: string | undefined;
    dailyCapUsd?: number;
    runCapUsd?: number;
    /** households.ai_daily_cap_usd; undefined leaves the store without the lookup (older database). */
    householdCap?: number | null;
  } = {},
): Harness {
  const rows: Harness["rows"] = [];
  const store = {
    spent: opts.spent ?? 0,
    runSpent: opts.runSpent === undefined ? 0 : opts.runSpent,
    isMember: vi.fn(
      async (h: string, u: string) => (opts.member ?? true) && h === HOUSEHOLD && u === ALICE,
    ),
    async spentSince() {
      return store.spent;
    },
    ...(opts.householdCap !== undefined
      ? { householdCapUsd: async () => opts.householdCap ?? null }
      : {}),
    async runSpentUsd() {
      return store.runSpent;
    },
    async logAiRun(record: AiRunRecord, runId: string | null) {
      rows.push({ record, runId });
    },
  };
  const fetchMock = vi.fn(async () => (opts.upstream ? opts.upstream() : sseResponse()));
  const runtime: Runtime = {
    authenticate: async (header) => (header === "Bearer alice" ? { userId: ALICE } : null),
    store,
    anthropicKey: "key" in opts ? opts.key : SERVER_KEY,
    fetch: fetchMock as unknown as typeof fetch,
    now: () => new Date("2026-10-31T18:00:00.000Z"),
    dailyCapUsd: opts.dailyCapUsd ?? 2,
    runCapUsd: opts.runCapUsd ?? 1,
    maxTokensPerCall: 4096,
  };
  return { runtime, rows, fetch: fetchMock, store };
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    householdId: HOUSEHOLD,
    runId: RUN,
    kind: "agent_step",
    model: "claude-haiku-5-5",
    system: "ping",
    messages: [{ role: "user", content: "ping" }],
    maxTokens: 16,
    ...overrides,
  };
}

function post(payload: unknown, auth: string | null = "Bearer alice"): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth) headers.Authorization = auth;
  return new Request("http://localhost/functions/v1/llm-proxy", {
    method: "POST",
    headers,
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

let logs: MockInstance[] = [];
const logged = () =>
  logs.flatMap((spy) => spy.mock.calls.map((args) => args.map(String).join(" ")));

beforeEach(() => {
  logs = [
    vi.spyOn(console, "log").mockImplementation(() => {}),
    vi.spyOn(console, "info").mockImplementation(() => {}),
    vi.spyOn(console, "warn").mockImplementation(() => {}),
    vi.spyOn(console, "error").mockImplementation(() => {}),
  ];
});

afterEach(() => {
  // Criterion 9: whatever happened in the test, the key is in no log line.
  for (const line of logged()) expect(line).not.toContain(SERVER_KEY);
  for (const spy of logs) spy.mockRestore();
});

describe("llm-proxy access", () => {
  it("a request from a non-member returns 403 and calls nothing", async () => {
    const h = harness();
    const res = await handleLlmProxy(post(body({ householdId: OTHER })), h.runtime);
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ ok: false, error: "not_a_member" });
    expect(text).not.toContain(SERVER_KEY);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.rows).toHaveLength(0);
  });

  it("refuses a missing or unknown session with 401", async () => {
    const h = harness();
    expect((await handleLlmProxy(post(body(), null), h.runtime)).status).toBe(401);
    expect((await handleLlmProxy(post(body(), "Bearer mallory"), h.runtime)).status).toBe(401);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("answers CORS preflight and refuses other methods", async () => {
    const h = harness();
    const pre = await handleLlmProxy(
      new Request("http://localhost/functions/v1/llm-proxy", { method: "OPTIONS" }),
      h.runtime,
    );
    expect(pre.status).toBe(204);
    const get = await handleLlmProxy(
      new Request("http://localhost/functions/v1/llm-proxy", { method: "GET" }),
      h.runtime,
    );
    expect(get.status).toBe(405);
  });
});

describe("llm-proxy forwarding", () => {
  it("forwards a request under the cap with the server key and writes one ai_runs row", async () => {
    const h = harness();
    const res = await handleLlmProxy(post(body({ runId: RUN })), h.runtime);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const streamed = await res.text();
    expect(streamed).toBe(SSE.join(""));
    expect(streamed).not.toContain(SERVER_KEY);

    expect(h.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(SERVER_KEY);
    expect(headers["anthropic-version"]).toBe(ANTHROPIC_VERSION);
    expect(JSON.parse(String(init.body))).toEqual({
      model: "claude-haiku-5-5",
      max_tokens: 16,
      system: "ping",
      messages: [{ role: "user", content: "ping" }],
      stream: true,
    });

    expect(h.rows).toHaveLength(1);
    const [{ record, runId }] = h.rows as [Harness["rows"][number]];
    expect(runId).toBe(RUN);
    expect(record).toMatchObject({
      householdId: HOUSEHOLD,
      kind: "agent_step",
      model: "claude-haiku-5-5",
      inputTokens: 1200,
      outputTokens: 42,
      cacheReadTokens: 800,
      ok: true,
      error: null,
    });
    expect(record.costUsd).toBeGreaterThan(0);
  });

  it("forwards tools with auto tool choice and an effort, and drops fields it does not know", async () => {
    const h = harness();
    const tools = [
      {
        name: "click",
        description: "Click a node",
        input_schema: { type: "object" },
        strict: true,
      },
    ];
    const res = await handleLlmProxy(
      post(
        body({
          kind: "agent_plan",
          model: "claude-sonnet-5-5",
          tools,
          effort: "low",
          thinking: { type: "enabled" },
          metadata: { user_id: "x" },
        }),
      ),
      h.runtime,
    );
    await res.text();
    const sent = JSON.parse(String((h.fetch.mock.calls[0] as [string, RequestInit])[1].body));
    expect(sent.tools).toEqual(tools);
    expect(sent.tool_choice).toEqual({ type: "auto" });
    expect(sent.output_config).toEqual({ effort: "low" });
    expect(sent).not.toHaveProperty("thinking");
    expect(sent).not.toHaveProperty("metadata");
    expect(h.rows[0]?.record.kind).toBe("agent_plan");
  });

  it("logs a failed row and passes a rate limit through, without the key", async () => {
    const h = harness({
      upstream: () =>
        Response.json(
          {
            type: "error",
            error: { type: "rate_limit_error", message: `slow down ${SERVER_KEY}` },
          },
          { status: 429 },
        ),
    });
    const res = await handleLlmProxy(post(body()), h.runtime);
    expect(res.status).toBe(429);
    const text = await res.text();
    expect(text).not.toContain(SERVER_KEY);
    expect(JSON.parse(text)).toMatchObject({ error: "upstream", type: "rate_limit_error" });
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]?.record).toMatchObject({ ok: false, error: "rate_limit_error", costUsd: 0 });
  });

  it("hides an upstream auth failure behind a 502", async () => {
    const h = harness({
      upstream: () =>
        Response.json(
          { error: { type: "authentication_error", message: "bad key" } },
          { status: 401 },
        ),
    });
    const res = await handleLlmProxy(post(body()), h.runtime);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "upstream_auth" });
  });

  it("logs the usage seen so far when the client goes away mid-stream", async () => {
    const h = harness();
    const res = await handleLlmProxy(post(body()), h.runtime);
    const reader = res.body?.getReader();
    await reader?.read();
    await reader?.cancel();
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]?.record).toMatchObject({ ok: false, error: "client_cancelled" });
  });

  it("answers 503 when the server has no key", async () => {
    const h = harness({ key: undefined });
    const res = await handleLlmProxy(post(body()), h.runtime);
    expect(res.status).toBe(503);
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

describe("llm-proxy cost caps", () => {
  it("a request that would exceed the daily cap returns 402 cost_cap and forwards nothing", async () => {
    const h = harness({ spent: 1.9999, dailyCapUsd: 2 });
    const res = await handleLlmProxy(
      post(body({ model: "claude-sonnet-5-5", maxTokens: 4096 })),
      h.runtime,
    );
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ ok: false, error: "cost_cap", scope: "daily" });
    expect(h.fetch).not.toHaveBeenCalled();
    // The refusal is a row (WS15): ok false, error cost_cap, nothing billed, tied to the run.
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({
      runId: RUN,
      record: {
        householdId: HOUSEHOLD,
        kind: "agent_step",
        model: "claude-sonnet-5-5",
        ok: false,
        error: "cost_cap",
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
      },
    });
  });

  it("WS15: the household's own cap decides, not AI_DAILY_CAP_USD", async () => {
    // $0.50 spent: under the server's $2, over this household's $0.01.
    const low = harness({ spent: 0.5, dailyCapUsd: 2, householdCap: 0.01 });
    const res = await handleLlmProxy(post(body()), low.runtime);
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: "cost_cap", scope: "daily" });
    expect(low.fetch).not.toHaveBeenCalled();
    expect(low.rows).toHaveLength(1);
    expect(low.rows[0]?.record).toMatchObject({ ok: false, error: "cost_cap" });

    // $5 spent under a household cap of $10 goes through, where the server's $2 would stop it.
    const high = harness({ spent: 5, dailyCapUsd: 2, householdCap: 10 });
    const ok = await handleLlmProxy(post(body()), high.runtime);
    expect(ok.status).toBe(200);
    await ok.text();

    // A household with no cap of its own (null) falls back to the server's.
    const fallback = harness({ spent: 5, dailyCapUsd: 2, householdCap: null });
    expect((await handleLlmProxy(post(body()), fallback.runtime)).status).toBe(402);
  });

  it("a household already at its cap is refused even for a tiny call", async () => {
    const h = harness({ spent: 2, dailyCapUsd: 2 });
    const res = await handleLlmProxy(post(body()), h.runtime);
    expect(res.status).toBe(402);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("a run past its cap returns 402 with scope run", async () => {
    const h = harness({ runSpent: 0.99, runCapUsd: 1 });
    const res = await handleLlmProxy(
      post(body({ runId: RUN, model: "claude-sonnet-5-5", maxTokens: 2000 })),
      h.runtime,
    );
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: "cost_cap", scope: "run" });
    expect(h.fetch).not.toHaveBeenCalled();
    // The run cap's refusal is a row too (WS15).
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({
      runId: RUN,
      record: { ok: false, error: "cost_cap", costUsd: 0 },
    });
  });

  it("the request's run cap can lower the server's, never raise it", async () => {
    const lower = harness({ runSpent: 0.1, runCapUsd: 1 });
    const res = await handleLlmProxy(post(body({ runId: RUN, runCapUsd: 0.1 })), lower.runtime);
    expect(res.status).toBe(402);
    const higher = harness({ runSpent: 0.9999, runCapUsd: 1 });
    const res2 = await handleLlmProxy(
      post(body({ runId: RUN, runCapUsd: 50, model: "claude-sonnet-5-5", maxTokens: 1000 })),
      higher.runtime,
    );
    expect(res2.status).toBe(402);
  });

  it("with no run spend known, the call itself must still fit the run cap", async () => {
    const h = harness({ runSpent: null, runCapUsd: 0.001 });
    const res = await handleLlmProxy(
      post(body({ runId: RUN, model: "claude-opus-5-5", maxTokens: 4096 })),
      h.runtime,
    );
    expect(res.status).toBe(402);
    const ok = harness({ runSpent: null, runCapUsd: 1 });
    const res2 = await handleLlmProxy(post(body({ runId: RUN })), ok.runtime);
    expect(res2.status).toBe(200);
    await res2.text();
  });

  it("fix round item 6: a request without runId is refused for every agent kind", async () => {
    const h = harness();
    for (const kind of ["agent_plan", "agent_step"]) {
      const res = await handleLlmProxy(post(body({ kind, runId: undefined })), h.runtime);
      expect(res.status, kind).toBe(400);
      expect(await res.json()).toMatchObject({ ok: false, error: "invalid_request" });
    }
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.rows).toHaveLength(0);
  });

  it("fix round item 6: until ai_runs.run_id exists the run cap applies to each call on its own", async () => {
    // runSpentUsd is null while the column is missing; the daily cap has plenty of room.
    const h = harness({ runSpent: null, spent: 0, dailyCapUsd: 2, runCapUsd: 0.0005 });
    const res = await handleLlmProxy(post(body({ maxTokens: 2000 })), h.runtime);
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: "cost_cap", scope: "run" });
    expect(h.fetch).not.toHaveBeenCalled();
    const small = await handleLlmProxy(post(body({ maxTokens: 16 })), h.runtime);
    expect(small.status).toBe(200);
    await small.text();
  });

  it("counts the call at its worst case", () => {
    const request = parseProxyRequest(body({ maxTokens: 1000 }), 4096);
    if ("status" in request) throw new Error("invalid");
    expect(estimateInputTokens(request)).toBeGreaterThan(0);
    // 1000 output tokens of Haiku alone are $0.0005.
    expect(worstCaseCostUsd(request)).toBeGreaterThanOrEqual(0.0005);
  });
});

describe("llm-proxy validation", () => {
  it("refuses bad bodies with 400 and oversized ones with 413", async () => {
    const h = harness();
    const cases: unknown[] = [
      "not json",
      body({ householdId: "nope" }),
      body({ kind: "agent.step" }),
      body({ model: "gpt-5" }),
      body({ messages: [] }),
      body({ messages: [{ role: "system", content: "x" }] }),
      body({ system: "" }),
      body({ maxTokens: 0 }),
      body({ maxTokens: 5000 }),
      body({ tools: [{ name: "x" }] }),
      body({ runId: "nope" }),
      body({ runCapUsd: -1 }),
      body({ effort: "max" }),
      body({ promptVersion: "drop table" }),
    ];
    for (const c of cases) {
      const res = await handleLlmProxy(post(c), h.runtime);
      expect(res.status, JSON.stringify(c)).toBe(400);
    }
    const huge = body({ system: "x".repeat(MAX_BODY_BYTES) });
    expect((await handleLlmProxy(post(huge), h.runtime)).status).toBe(413);
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

describe("UsageMeter", () => {
  it("reads usage from events split across chunks", () => {
    const meter = new UsageMeter();
    const bytes = new TextEncoder().encode(SSE.join(""));
    for (let i = 0; i < bytes.length; i += 7) meter.push(bytes.slice(i, i + 7));
    expect(meter.usage()).toEqual({
      inputTokens: 1200,
      outputTokens: 42,
      cacheReadTokens: 800,
      cacheWriteTokens: 0,
    });
    expect(meter.stopReason).toBe("end_turn");
  });
});

describe("the service store", () => {
  function fakeDb(opts: { runIdColumn: boolean }) {
    const inserts: Record<string, unknown>[] = [];
    const rpc = vi.fn(async () => ({ data: "0.42", error: null }));
    const db: ServiceDb = {
      from(table: string) {
        const filters: [string, string][] = [];
        const query = {
          eq(column: string, value: string) {
            filters.push([column, value]);
            return query;
          },
          limit() {
            return query;
          },
          // biome-ignore lint/suspicious/noThenProperty: a PostgREST builder is a thenable.
          then(resolve: (v: unknown) => unknown) {
            if (table === "ai_runs" && selected === "run_id") {
              return Promise.resolve(
                resolve(
                  opts.runIdColumn
                    ? { data: [], error: null }
                    : {
                        data: null,
                        error: { message: "column ai_runs.run_id does not exist", code: "42703" },
                      },
                ),
              );
            }
            if (table === "ai_runs") {
              return Promise.resolve(
                resolve({ data: [{ cost_usd: 0.1 }, { cost_usd: "0.15" }], error: null }),
              );
            }
            if (table === "households") {
              const known = filters.some(([c, v]) => c === "id" && v === HOUSEHOLD);
              return Promise.resolve(
                resolve({ data: known ? [{ ai_daily_cap_usd: "0.75" }] : [], error: null }),
              );
            }
            const member = filters.some(([c, v]) => c === "user_id" && v === ALICE);
            return Promise.resolve(
              resolve({ data: member ? [{ user_id: ALICE }] : [], error: null }),
            );
          },
        };
        let selected = "";
        return {
          select(columns: string) {
            selected = columns;
            return query as never;
          },
          insert(row: Record<string, unknown>) {
            inserts.push({ table, ...row });
            return Promise.resolve({ error: null });
          },
        };
      },
      rpc: rpc as never,
    };
    return { db, inserts, rpc };
  }

  const record: AiRunRecord = {
    householdId: HOUSEHOLD,
    kind: "agent_step",
    model: "claude-haiku-5-5",
    promptVersion: null,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    costUsd: 0.0001,
    latencyMs: 12,
    ok: true,
    error: null,
  };

  it("writes rows without run_id and knows no run spend while ai_runs lacks the column", async () => {
    const { db, inserts, rpc } = fakeDb({ runIdColumn: false });
    const store = createServiceStore(db);
    expect(await store.isMember(HOUSEHOLD, ALICE)).toBe(true);
    expect(await store.isMember(HOUSEHOLD, "someone-else")).toBe(false);
    expect(await store.spentSince(HOUSEHOLD, "2026-10-31T00:00:00.000Z")).toBe(0.42);
    expect(rpc).toHaveBeenCalledWith("household_ai_spend_since", {
      p_household_id: HOUSEHOLD,
      p_since: "2026-10-31T00:00:00.000Z",
    });
    expect(await store.runSpentUsd(HOUSEHOLD, RUN)).toBeNull();
    await store.logAiRun(record, RUN);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).not.toHaveProperty("run_id");
    expect(inserts[0]).toMatchObject({
      table: "ai_runs",
      household_id: HOUSEHOLD,
      kind: "agent_step",
    });
  });

  it("WS15: reads the household's own daily cap from its row", async () => {
    const { db } = fakeDb({ runIdColumn: true });
    const store = createServiceStore(db);
    expect(await store.householdCapUsd?.(HOUSEHOLD)).toBe(0.75);
    expect(await store.householdCapUsd?.("0f000000-0000-4000-8000-00000000000f")).toBeNull();
  });

  it("writes and sums by run_id once the column exists", async () => {
    const { db, inserts } = fakeDb({ runIdColumn: true });
    const store = createServiceStore(db);
    expect(await store.runSpentUsd(HOUSEHOLD, RUN)).toBeCloseTo(0.25);
    await store.logAiRun(record, RUN);
    expect(inserts[0]).toMatchObject({ run_id: RUN });
  });
});

describe("runtimeFromEnv", () => {
  it("reads the caps and the per-call token limit from the environment", async () => {
    const { runtimeFromEnv, DEFAULT_MAX_TOKENS_PER_CALL } = await import("./index.ts");
    const env: Record<string, string> = {
      SUPABASE_URL: "http://localhost:54321",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
      ANTHROPIC_API_KEY: ` ${SERVER_KEY} `,
      AI_DAILY_CAP_USD: "3.5",
      LLM_PROXY_RUN_CAP_USD: "0.4",
      LLM_PROXY_MAX_TOKENS_PER_CALL: "2048",
    };
    const runtime = runtimeFromEnv((name) => env[name]);
    expect(runtime.anthropicKey).toBe(SERVER_KEY);
    expect(runtime.dailyCapUsd).toBe(3.5);
    expect(runtime.runCapUsd).toBe(0.4);
    expect(runtime.maxTokensPerCall).toBe(2048);
    const defaults = runtimeFromEnv((name) =>
      name.startsWith("SUPABASE_") ? env[name] : undefined,
    );
    expect(defaults.anthropicKey).toBeUndefined();
    expect(defaults.maxTokensPerCall).toBe(DEFAULT_MAX_TOKENS_PER_CALL);
    expect(() => runtimeFromEnv(() => undefined)).toThrow("SUPABASE_URL");
  });
});

describe("fix round item 7: supabase/config.toml", () => {
  it("declares llm-proxy with verify_jwt = true", () => {
    const toml = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "..", "config.toml"),
      "utf8",
    );
    const section = /\[functions\.llm-proxy\]([\s\S]*?)(?=\n\[|$)/.exec(toml)?.[1] ?? "";
    expect(section).toMatch(/^verify_jwt = true$/m);
    expect(section).toMatch(/^entrypoint = "\.\/functions\/llm-proxy\/index\.ts"$/m);
  });
});
