// llm-proxy request handling (WS08). No Deno globals and no supabase-js here: the handler takes a
// `Runtime`, so Vitest drives it with fakes (index.test.ts) and index.ts builds the real one.
//
// The on-device shopping agent (Tier 3, Mode A) runs in the app, but the app bundle never holds the
// Anthropic key. Its model calls come here. The order of work:
//   1. Authenticate, validate, and check the caller belongs to the household.
//   2. Cost caps, before any model call: the household's daily cap (createDailyCapGuard from
//      @mp/llm, AI_DAILY_CAP_USD, as suggest does) and the run's cap (the request's runCapUsd,
//      never above LLM_PROXY_RUN_CAP_USD). Both count this call at its worst case: its input
//      estimated from the request size and all of maxTokens as output. 402 { error: "cost_cap" }.
//      runId is required, so the run cap always applies. Until ai_runs has a run_id column (an
//      orchestrator migration after WS09) the run's spend so far is unknown and the cap applies to
//      each call on its own; store.ts picks the column up when it exists.
//   3. Forward to the Messages API with the server key, streaming, and pass the stream through.
//   4. Read usage from the stream as it passes and write one ai_runs row when it ends.
//
// The request carries only what the agent needs: model, system, messages, tools, maxTokens and an
// effort. Nothing else reaches Anthropic, so a client cannot turn on parameters we do not use.
import { LlmError, MODELS } from "../../../packages/llm/src/client.ts";
import {
  type AiRunRecord,
  createDailyCapGuard,
  estimateCostUsd,
  type TokenUsage,
} from "../../../packages/llm/src/log.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/** Largest request accepted, in bytes. A step carries a page snapshot capped by maxNodes. */
export const MAX_BODY_BYTES = 600_000;
export const ANTHROPIC_VERSION = "2023-06-01";
export const KINDS = ["agent_plan", "agent_step"] as const;
export type ProxyKind = (typeof KINDS)[number];
const ALLOWED_MODELS: readonly string[] = Object.values(MODELS);
const EFFORTS = ["low", "medium", "high"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROMPT_VERSION = /^[a-z0-9-]{1,60}\.v\d{1,4}$/;

export interface ProxyRequest {
  householdId: string;
  runId: string;
  kind: ProxyKind;
  model: string;
  system: string | Record<string, unknown>[];
  messages: Record<string, unknown>[];
  tools: Record<string, unknown>[] | null;
  maxTokens: number;
  runCapUsd: number | null;
  effort: (typeof EFFORTS)[number] | null;
  promptVersion: string | null;
}

export interface ProxyStore {
  isMember(householdId: string, userId: string): Promise<boolean>;
  /** USD the household spent on model calls since `sinceIso`. */
  spentSince(householdId: string, sinceIso: string): Promise<number>;
  /** households.ai_daily_cap_usd (WS15); null when unknown, so AI_DAILY_CAP_USD applies. */
  householdCapUsd?(householdId: string): Promise<number | null>;
  /** USD this household spent in this run so far; null when it cannot be known (see index.ts). */
  runSpentUsd(householdId: string, runId: string): Promise<number | null>;
  /** Writes one ai_runs row. Must not throw. */
  logAiRun(record: AiRunRecord, runId: string | null): Promise<void>;
}

export interface Runtime {
  authenticate(authHeader: string): Promise<{ userId: string } | null>;
  store: ProxyStore;
  /** The server-side Anthropic key. Absent: every call answers 503. Never logged or returned. */
  anthropicKey: string | undefined;
  /** Default https://api.anthropic.com. */
  anthropicBaseUrl?: string;
  fetch: typeof fetch;
  now(): Date;
  dailyCapUsd: number;
  /** The most a run may spend, and the default when the request names no cap. */
  runCapUsd: number;
  maxTokensPerCall: number;
}

type Fail = { status: number; error: string; message: string; extra?: Record<string, unknown> };

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } });
}

function fail(f: Fail): Response {
  return json({ ok: false, error: f.error, message: f.message, ...(f.extra ?? {}) }, f.status);
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

function invalid(message: string): Fail {
  return { status: 400, error: "invalid_request", message };
}

/** Validates the body. Returns the request or what is wrong with it. */
export function parseProxyRequest(raw: unknown, maxTokensPerCall: number): ProxyRequest | Fail {
  if (!isObject(raw)) return invalid("The body must be a JSON object.");
  const { householdId, runId, kind, model, system, messages, tools, maxTokens } = raw;
  if (typeof householdId !== "string" || !UUID.test(householdId)) {
    return invalid("householdId: must be a uuid");
  }
  // Every agent call belongs to a run, so the run cap always applies (decided 2026-10-31).
  if (typeof runId !== "string" || !UUID.test(runId)) {
    return invalid("runId: required, a uuid");
  }
  if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) {
    return invalid(`kind: must be one of ${KINDS.join(", ")}`);
  }
  if (typeof model !== "string" || !ALLOWED_MODELS.includes(model)) {
    return invalid(`model: must be one of ${ALLOWED_MODELS.join(", ")}`);
  }
  const systemOk =
    (typeof system === "string" && system.length > 0) ||
    (Array.isArray(system) &&
      system.length > 0 &&
      system.every((b) => isObject(b) && b.type === "text" && typeof b.text === "string"));
  if (!systemOk) return invalid("system: a string or an array of text blocks");
  if (
    !Array.isArray(messages) ||
    messages.length === 0 ||
    !messages.every(
      (m) =>
        isObject(m) &&
        (m.role === "user" || m.role === "assistant") &&
        (typeof m.content === "string" ||
          (Array.isArray(m.content) &&
            m.content.every((b) => isObject(b) && typeof b.type === "string"))),
    )
  ) {
    return invalid("messages: a non-empty array of { role, content }");
  }
  if (
    tools !== undefined &&
    tools !== null &&
    (!Array.isArray(tools) ||
      !tools.every((t) => isObject(t) && typeof t.name === "string" && isObject(t.input_schema)))
  ) {
    return invalid("tools: an array of { name, input_schema }");
  }
  if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens < 1) {
    return invalid("maxTokens: a positive integer");
  }
  if (maxTokens > maxTokensPerCall) {
    return invalid(`maxTokens: at most ${maxTokensPerCall} per call`);
  }
  const runCap = raw.runCapUsd;
  if (runCap !== undefined && runCap !== null && (typeof runCap !== "number" || !(runCap > 0))) {
    return invalid("runCapUsd: a positive number");
  }
  const effort = raw.effort;
  if (
    effort !== undefined &&
    effort !== null &&
    !(EFFORTS as readonly unknown[]).includes(effort)
  ) {
    return invalid(`effort: one of ${EFFORTS.join(", ")}`);
  }
  const promptVersion = raw.promptVersion;
  if (
    promptVersion !== undefined &&
    promptVersion !== null &&
    (typeof promptVersion !== "string" || !PROMPT_VERSION.test(promptVersion))
  ) {
    return invalid('promptVersion: "<name>.v<n>"');
  }
  return {
    householdId: householdId.toLowerCase(),
    runId: runId.toLowerCase(),
    kind: kind as ProxyKind,
    model,
    system: system as ProxyRequest["system"],
    messages: messages as Record<string, unknown>[],
    tools: (tools as Record<string, unknown>[] | undefined) ?? null,
    maxTokens,
    runCapUsd: typeof runCap === "number" ? runCap : null,
    effort: (effort as ProxyRequest["effort"]) ?? null,
    promptVersion: typeof promptVersion === "string" ? promptVersion : null,
  };
}

/** Rough input tokens from the request size: about 3 characters a token, rounded up. */
export function estimateInputTokens(request: ProxyRequest): number {
  const size = JSON.stringify([request.system, request.messages, request.tools]).length;
  return Math.ceil(size / 3);
}

/** The most this call can cost: estimated input, all of maxTokens as output, no cache discount. */
export function worstCaseCostUsd(request: ProxyRequest): number {
  return estimateCostUsd(request.model, {
    inputTokens: estimateInputTokens(request),
    outputTokens: request.maxTokens,
  });
}

function startOfUtcDay(now: Date): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
}

/** The Messages API body. Only fields the agent uses; streaming always on. */
export function upstreamBody(request: ProxyRequest): Record<string, unknown> {
  return {
    model: request.model,
    max_tokens: request.maxTokens,
    system: request.system,
    messages: request.messages,
    ...(request.tools && request.tools.length > 0
      ? { tools: request.tools, tool_choice: { type: "auto" } }
      : {}),
    ...(request.effort ? { output_config: { effort: request.effort } } : {}),
    stream: true,
  };
}

/** Usage as the stream reports it: message_start carries input, message_delta the running output. */
export class UsageMeter {
  inputTokens = 0;
  outputTokens = 0;
  cacheReadTokens = 0;
  cacheWriteTokens = 0;
  stopReason: string | null = null;
  streamError: string | null = null;
  #buffer = "";
  #decoder = new TextDecoder();

  push(chunk: Uint8Array): void {
    this.#buffer += this.#decoder.decode(chunk, { stream: true });
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.startsWith("data:")) this.#read(line.slice(5).trim());
      newline = this.#buffer.indexOf("\n");
    }
  }

  #read(data: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    const usage = (u: unknown) => (isObject(u) ? u : {});
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    if (event.type === "message_start" && isObject(event.message)) {
      const u = usage(event.message.usage);
      this.inputTokens = num(u.input_tokens) ?? this.inputTokens;
      this.outputTokens = num(u.output_tokens) ?? this.outputTokens;
      this.cacheReadTokens = num(u.cache_read_input_tokens) ?? this.cacheReadTokens;
      this.cacheWriteTokens = num(u.cache_creation_input_tokens) ?? this.cacheWriteTokens;
    } else if (event.type === "message_delta") {
      const u = usage(event.usage);
      this.outputTokens = num(u.output_tokens) ?? this.outputTokens;
      this.inputTokens = num(u.input_tokens) ?? this.inputTokens;
      this.cacheReadTokens = num(u.cache_read_input_tokens) ?? this.cacheReadTokens;
      this.cacheWriteTokens = num(u.cache_creation_input_tokens) ?? this.cacheWriteTokens;
      if (isObject(event.delta) && typeof event.delta.stop_reason === "string") {
        this.stopReason = event.delta.stop_reason;
      }
    } else if (event.type === "error" && isObject(event.error)) {
      this.streamError = typeof event.error.type === "string" ? event.error.type : "stream_error";
    }
  }

  usage(): TokenUsage {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheWriteTokens: this.cacheWriteTokens,
    };
  }
}

function scrub(text: string, secret: string | undefined): string {
  return secret ? text.split(secret).join("[redacted]") : text;
}

function record(
  request: ProxyRequest,
  usage: TokenUsage,
  latencyMs: number,
  ok: boolean,
  error: string | null,
): AiRunRecord {
  return {
    householdId: request.householdId,
    kind: request.kind,
    model: request.model,
    promptVersion: request.promptVersion,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    costUsd: estimateCostUsd(request.model, usage),
    latencyMs,
    ok,
    error,
  };
}

export async function handleLlmProxy(req: Request, runtime: Runtime): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") {
    return Response.json(
      { ok: false, error: "method_not_allowed" },
      { status: 405, headers: { ...CORS_HEADERS, Allow: "POST, OPTIONS" } },
    );
  }

  const authHeader = req.headers.get("authorization");
  if (!authHeader || !/^Bearer\s+\S+/i.test(authHeader)) {
    return fail({ status: 401, error: "unauthorized", message: "Sign in first." });
  }
  let user: { userId: string } | null = null;
  try {
    user = await runtime.authenticate(authHeader);
  } catch {
    console.error("llm-proxy: auth check failed");
  }
  if (!user) return fail({ status: 401, error: "unauthorized", message: "Sign in first." });

  let raw: unknown;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) {
      return fail({ status: 413, error: "invalid_request", message: "The request is too large." });
    }
    raw = JSON.parse(text);
  } catch {
    return fail(invalid("The body is not valid JSON."));
  }
  const parsed = parseProxyRequest(raw, runtime.maxTokensPerCall);
  if ("status" in parsed) return fail(parsed);
  const request = parsed;

  try {
    if (!(await runtime.store.isMember(request.householdId, user.userId))) {
      return fail({
        status: 403,
        error: "not_a_member",
        message: "You are not a member of this household.",
      });
    }
  } catch {
    console.error("llm-proxy: membership check failed");
    return fail({ status: 500, error: "internal_error", message: "Try again." });
  }

  const apiKey = runtime.anthropicKey?.trim();
  if (!apiKey) {
    return fail({
      status: 503,
      error: "model_unavailable",
      message: "The model is not configured on the server.",
    });
  }

  // Caps, before any model call.
  const projected = worstCaseCostUsd(request);
  const now = runtime.now();
  const refused = (): AiRunRecord =>
    record(request, { inputTokens: 0, outputTokens: 0 }, 0, false, "cost_cap");
  const daily = createDailyCapGuard({
    capUsd: runtime.dailyCapUsd,
    ...(runtime.store.householdCapUsd
      ? { capFor: (id: string) => runtime.store.householdCapUsd?.(id) ?? Promise.resolve(null) }
      : {}),
    spentTodayUsd: async (id) =>
      (await runtime.store.spentSince(id, startOfUtcDay(now))) + projected,
    // The refusal is a row, like every other call (WS15). The projected worst case is not billed,
    // so the row costs nothing.
    sink: (row) => runtime.store.logAiRun(row, request.runId),
    onWarning: () => console.warn("llm-proxy: daily spend lookup failed; the cap was not applied"),
  });
  try {
    await daily.check(request.householdId, {
      kind: request.kind,
      model: request.model,
      promptVersion: request.promptVersion,
      runId: request.runId,
    });
  } catch (err) {
    if (err instanceof LlmError && err.code === "cost_cap") {
      return fail({
        status: 402,
        error: "cost_cap",
        message: "The household reached today's model budget.",
        extra: { scope: "daily" },
      });
    }
    throw err;
  }
  // The run cap. With no run spend known (no ai_runs.run_id yet, or a failed lookup) this call
  // alone must fit under it.
  const runCap = Math.min(request.runCapUsd ?? runtime.runCapUsd, runtime.runCapUsd);
  let spent: number | null = null;
  try {
    spent = await runtime.store.runSpentUsd(request.householdId, request.runId);
  } catch {
    console.warn("llm-proxy: run spend lookup failed; only this call counts toward the run cap");
  }
  if ((spent ?? 0) + projected >= runCap) {
    await runtime.store.logAiRun(refused(), request.runId);
    return fail({
      status: 402,
      error: "cost_cap",
      message: "This run reached its model budget.",
      extra: { scope: "run" },
    });
  }

  // Forward.
  const started = Date.now();
  const base = (runtime.anthropicBaseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
  let upstream: Response;
  try {
    upstream = await runtime.fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(upstreamBody(request)),
    });
  } catch {
    console.error("llm-proxy: the model API could not be reached");
    await runtime.store.logAiRun(
      record(request, { inputTokens: 0, outputTokens: 0 }, Date.now() - started, false, "network"),
      request.runId,
    );
    return fail({ status: 502, error: "upstream", message: "The model could not be reached." });
  }

  if (!upstream.ok || !upstream.body) {
    const text = scrub(await upstream.text().catch(() => ""), apiKey);
    let type = `http_${upstream.status}`;
    let message = "The model refused the request.";
    try {
      const body = JSON.parse(text) as { error?: { type?: string; message?: string } };
      if (body.error?.type) type = body.error.type;
      if (body.error?.message) message = scrub(body.error.message, apiKey).slice(0, 500);
    } catch {
      // not JSON
    }
    console.warn(`llm-proxy: model API answered ${upstream.status} (${type})`);
    await runtime.store.logAiRun(
      record(request, { inputTokens: 0, outputTokens: 0 }, Date.now() - started, false, type),
      request.runId,
    );
    // Our key failing is our problem, not the caller's: say so without detail.
    if (upstream.status === 401 || upstream.status === 403) {
      return fail({ status: 502, error: "upstream_auth", message: "The model is not available." });
    }
    const status = upstream.status === 429 || upstream.status >= 500 ? upstream.status : 400;
    return fail({ status, error: "upstream", message, extra: { type } });
  }

  // Stream through, counting usage on the way. The row is written before the stream closes, so
  // the function's work is done when the client has read the last event.
  const meter = new UsageMeter();
  const reader = upstream.body.getReader();
  let logged = false;
  const writeRow = async (cancelled: boolean) => {
    if (logged) return;
    logged = true;
    const error = meter.streamError ?? (cancelled ? "client_cancelled" : null);
    await runtime.store.logAiRun(
      record(request, meter.usage(), Date.now() - started, error === null, error),
      request.runId,
    );
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          await writeRow(false);
          controller.close();
          return;
        }
        meter.push(value);
        controller.enqueue(value);
      } catch {
        console.warn("llm-proxy: the model stream broke off");
        await writeRow(true);
        controller.error(new Error("upstream stream failed"));
      }
    },
    async cancel(reason) {
      await writeRow(true);
      await reader.cancel(reason).catch(() => {});
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
    },
  });
}
