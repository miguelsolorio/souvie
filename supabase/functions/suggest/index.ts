// suggest (WS06): the weekly dinner plan, the calibration cards for onboarding, and the embedding
// backfill.
//
//   POST { "householdId", "weekStart" (a Monday), "mode": "draft" | "replace" | "calibration" | "backfill",
//          "dinners"?, "date"? }
//     -> draft, replace:  { ok: true, planId, entries: [{ date, slot, recipeId, servings, why }],
//                           composedBy, notes?, shortBy? }
//        calibration:     { ok: true, recipeIds, cards }
//        backfill:        { ok: true, embedded, remaining }
//     or { ok: false, error, message }
//
// Needs a signed-in member of the household (verify_jwt stays on). Request and response shapes
// are in @mp/core (preferences.ts); how it works and what it reads and writes is in README.md.
// Handler logic is in handler.ts and takes a `Runtime`, so Vitest drives it with PGlite and
// fakes; this file only builds the real one.
import { createAnthropicClient, type MessagesClient } from "../../../packages/llm/src/index.ts";
import { connect, createClient } from "./client.ts";
import { handleSuggest, type Runtime } from "./handler.ts";
import { runnerOf } from "./sql.ts";

type Env = (name: string) => string | undefined;

/** USD a household may spend on model and embedding calls per UTC day, unless AI_DAILY_CAP_USD says otherwise. */
export const DEFAULT_DAILY_CAP_USD = 2;

function dailyCap(env: Env): number {
  const raw = Number(env("AI_DAILY_CAP_USD"));
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAILY_CAP_USD;
}

/** Builds the real runtime from the environment Supabase provides plus the optional model keys. */
export function runtimeFromEnv(env: Env): Runtime {
  const url = env("SUPABASE_URL");
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  const dbUrl = env("SUPABASE_DB_URL");
  const anthropicKey = env("ANTHROPIC_API_KEY")?.trim();
  const voyageKey = env("VOYAGE_API_KEY")?.trim();
  if (!url || !serviceKey || !dbUrl) {
    throw new Error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_DB_URL are required");
  }
  const serviceDb = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const sql = runnerOf(connect(dbUrl));

  let anthropic: MessagesClient | undefined;

  return {
    async authenticate(authHeader) {
      const token = authHeader.replace(/^Bearer\s+/i, "");
      const { data, error } = await serviceDb.auth.getUser(token);
      return error || !data.user ? null : { userId: data.user.id };
    },
    sql,
    now: () => new Date(),
    ...(anthropicKey
      ? {
          anthropic: async () => {
            anthropic ??= await createAnthropicClient({ apiKey: anthropicKey });
            return anthropic;
          },
        }
      : {}),
    voyageKey: voyageKey || undefined,
    async signImagePaths(paths) {
      const signed = new Map<string, string>();
      if (paths.length === 0) return signed;
      const { data, error } = await serviceDb.storage
        .from("recipe-images")
        .createSignedUrls([...paths], 3600);
      if (error || !data) return signed;
      for (const item of data) {
        if (item.path && item.signedUrl) signed.set(item.path, item.signedUrl);
      }
      return signed;
    },
    dailyCapUsd: dailyCap(env),
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
      return handleSuggest(req, runtime());
    } catch (err) {
      console.error("suggest is misconfigured", err);
      return Response.json({ ok: false, error: "internal_error" }, { status: 500 });
    }
  },
};
