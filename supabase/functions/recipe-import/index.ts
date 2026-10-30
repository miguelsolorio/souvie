// recipe-import (WS02): URL, pasted text, photo, or caption to a recipe.
//
//   POST { "kind": "url" | "text" | "image" | "caption", "input": ..., "householdId"?, "save"? }
//     -> { ok: true, jobId, path, recipeId?, draft?, warnings }   or   { ok: false, error, message }
//
// Needs a signed-in user (verify_jwt stays on) who belongs to the household. Shapes, limits, and
// the error table are in README.md. Handler logic is in handler.ts and takes a `Runtime`, so
// Vitest drives it with fakes; this file only builds the real one.

import {
  createAnthropicClient,
  createDailyCapGuard,
  extract,
  logAiRun,
  type MessagesClient,
} from "../../../packages/llm/src/index.ts";
import type { ModelExtract } from "../../../packages/recipe-import/src/index.ts";
import { createClient } from "./client.ts";
import { handleRecipeImport, type Runtime } from "./handler.ts";
import { SupabaseImportStore } from "./store.ts";

type Env = (name: string) => string | undefined;
type DenoLike = {
  env: { get(name: string): string | undefined };
  resolveDns?(hostname: string, type: "A" | "AAAA"): Promise<string[]>;
};

/** USD a household may spend on model calls per UTC day, unless AI_DAILY_CAP_USD says otherwise. */
export const DEFAULT_DAILY_CAP_USD = 2;

function dailyCap(env: Env): number {
  const raw = Number(env("AI_DAILY_CAP_USD"));
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAILY_CAP_USD;
}

function startOfUtcDay(now: Date): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
}

/** Builds the real runtime from the environment Supabase provides plus ANTHROPIC_API_KEY. */
export function runtimeFromEnv(env: Env, deno?: DenoLike): Runtime {
  const url = env("SUPABASE_URL");
  const anonKey = env("SUPABASE_ANON_KEY");
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  const anthropicKey = env("ANTHROPIC_API_KEY");
  if (!url || !anonKey || !serviceKey) {
    throw new Error("SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY are required");
  }
  const authOptions = { persistSession: false, autoRefreshToken: false };
  const serviceDb = createClient(url, serviceKey, { auth: authOptions });
  const userClient = (authHeader: string) =>
    createClient(url, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: authOptions,
    });
  const store = new SupabaseImportStore(serviceDb, userClient);
  const capUsd = dailyCap(env);

  let anthropic: MessagesClient | undefined;

  return {
    async authenticate(authHeader) {
      const token = authHeader.replace(/^Bearer\s+/i, "");
      const { data, error } = await serviceDb.auth.getUser(token);
      return error || !data.user ? null : { userId: data.user.id };
    },
    store,
    now: () => new Date(),
    modelFor(householdId) {
      if (!anthropicKey) return undefined;
      const guard = createDailyCapGuard({
        capUsd,
        spentTodayUsd: (id) => store.spentSince(id, startOfUtcDay(new Date())),
      });
      const model: ModelExtract = async (schema, request) => {
        anthropic ??= await createAnthropicClient({ apiKey: anthropicKey });
        return extract(
          schema,
          { ...request, householdId },
          { client: anthropic, guard, log: (run) => logAiRun(serviceDb.from("ai_runs"), run) },
        );
      };
      return model;
    },
    ...(deno?.resolveDns
      ? {
          async resolveHost(hostname: string) {
            const resolve = deno.resolveDns?.bind(deno);
            if (!resolve) return [];
            const answers = await Promise.allSettled([
              resolve(hostname, "A"),
              resolve(hostname, "AAAA"),
            ]);
            const addresses = answers.flatMap((a) => (a.status === "fulfilled" ? a.value : []));
            if (addresses.length === 0) throw new Error(`no address for ${hostname}`);
            return addresses;
          },
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

let cached: Runtime | undefined;

function runtime(): Runtime {
  if (!cached) {
    const deno = (globalThis as { Deno?: DenoLike }).Deno;
    cached = runtimeFromEnv((name) => deno?.env.get(name), deno);
  }
  return cached;
}

export default {
  fetch(req: Request): Promise<Response> | Response {
    try {
      return handleRecipeImport(req, runtime());
    } catch (err) {
      console.error("recipe-import is misconfigured", err);
      return Response.json({ ok: false, error: "internal_error" }, { status: 500 });
    }
  },
};
