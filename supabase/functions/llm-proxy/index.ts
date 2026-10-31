// llm-proxy (WS08): the model endpoint for the on-device Tier 3 shopping agent.
//
//   POST { householdId, runId?, kind: "agent_plan" | "agent_step", model, system, messages,
//          tools?, maxTokens, runCapUsd?, effort?, promptVersion? }
//     -> 200 text/event-stream: the Messages API stream, passed through unchanged
//     or { ok: false, error, message }: 400 invalid_request, 401 unauthorized, 402 cost_cap
//        (with scope "daily" or "run"), 403 not_a_member, 413, 429/5xx upstream, 502, 503
//
// Needs a signed-in member of the household (verify_jwt stays on). The app bundle never holds the
// Anthropic key: it lives here as a Supabase secret, is sent only to api.anthropic.com, and is never
// logged or returned. Every call writes one ai_runs row. Handler logic is in handler.ts and takes a
// `Runtime`, so Vitest drives it with fakes; this file only builds the real one. WS09's worker
// calls @mp/llm directly and does not use this function.
import { createClient } from "./client.ts";
import { handleLlmProxy, type Runtime } from "./handler.ts";
import { createServiceStore, type ServiceDb } from "./store.ts";

type Env = (name: string) => string | undefined;

/** USD a household may spend on model calls per UTC day, unless AI_DAILY_CAP_USD says otherwise. */
export const DEFAULT_DAILY_CAP_USD = 2;
/** USD one run may spend, unless LLM_PROXY_RUN_CAP_USD says otherwise. docs/03 expects under $0.30. */
export const DEFAULT_RUN_CAP_USD = 1;
/** Output tokens one call may ask for, unless LLM_PROXY_MAX_TOKENS_PER_CALL says otherwise. */
export const DEFAULT_MAX_TOKENS_PER_CALL = 4096;

function positive(env: Env, name: string, fallback: number): number {
  const raw = Number(env(name));
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export function runtimeFromEnv(env: Env, fetchImpl: typeof fetch = fetch): Runtime {
  const url = env("SUPABASE_URL");
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }
  const serviceDb = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return {
    async authenticate(authHeader) {
      const token = authHeader.replace(/^Bearer\s+/i, "");
      const { data, error } = await serviceDb.auth.getUser(token);
      return error || !data.user ? null : { userId: data.user.id };
    },
    store: createServiceStore(serviceDb as unknown as ServiceDb),
    anthropicKey: env("ANTHROPIC_API_KEY")?.trim() || undefined,
    fetch: fetchImpl,
    now: () => new Date(),
    dailyCapUsd: positive(env, "AI_DAILY_CAP_USD", DEFAULT_DAILY_CAP_USD),
    runCapUsd: positive(env, "LLM_PROXY_RUN_CAP_USD", DEFAULT_RUN_CAP_USD),
    maxTokensPerCall: Math.floor(
      positive(env, "LLM_PROXY_MAX_TOKENS_PER_CALL", DEFAULT_MAX_TOKENS_PER_CALL),
    ),
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

type DenoLike = { env: { get(name: string): string | undefined } };

let cached: Runtime | undefined;

function runtime(): Runtime {
  if (!cached) {
    const deno = (globalThis as { Deno?: DenoLike }).Deno;
    cached = runtimeFromEnv((name) => deno?.env.get(name));
  }
  return cached;
}

export default {
  fetch(req: Request): Promise<Response> | Response {
    try {
      return handleLlmProxy(req, runtime());
    } catch {
      console.error("llm-proxy is misconfigured");
      return Response.json({ ok: false, error: "internal_error" }, { status: 500 });
    }
  },
};
