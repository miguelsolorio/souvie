// list-build (WS05): turns a week's plan into the household's grocery list.
//
//   POST { "weekStart": "2026-11-02", "householdId"?: "<uuid>" }
//     -> { ok: true, listId, itemCount, needsAttentionCount, alreadyHaveCount, planVersion,
//          skippedEntryCount, rebuilt }
//     or { ok: false, error, message }
//
// Needs a signed-in member of the household (verify_jwt stays on). Request and response shapes
// are in @mp/core (list/types.ts); how it works and what it reads and writes is in README.md.
// Handler logic is in handler.ts and takes a `Runtime`, so Vitest drives it with PGlite and
// fakes; this file only builds the real one.
import { connect, createClient } from "./client.ts";
import { handleListBuild, type Runtime } from "./handler.ts";
import { runnerOf } from "./sql.ts";
import { SqlListStore } from "./store.ts";

type Env = (name: string) => string | undefined;

/** Builds the real runtime from the environment Supabase provides to every Edge Function. */
export function runtimeFromEnv(env: Env): Runtime {
  const url = env("SUPABASE_URL");
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  const dbUrl = env("SUPABASE_DB_URL");
  if (!url || !serviceKey || !dbUrl) {
    throw new Error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_DB_URL are required");
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
    store: new SqlListStore(runnerOf(connect(dbUrl))),
    now: () => new Date(),
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
      return handleListBuild(req, runtime());
    } catch (err) {
      console.error("list-build is misconfigured", err);
      return Response.json({ ok: false, error: "internal_error" }, { status: 500 });
    }
  },
};
