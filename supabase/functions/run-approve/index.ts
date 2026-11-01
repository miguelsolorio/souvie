// run-approve (WS09): the person's approval of a proposed cart. Applies their keep, swap, remove
// and quantity decisions, checks the approved cart against the budget cap, and moves the run from
// needs_review to running for the push phase, with a queue message for the worker.
//
//   POST { "runId": "<uuid>", "decisions": [{ "runItemId": "<uuid>", "action": "swap",
//          "alternativeIndex": 0 }] }
//     -> { ok: true, runId, status: "running", subtotalUsd, itemCount }
//     or { ok: false, error, message }
//
// Needs a signed-in member of the run's household (verify_jwt stays on). Handler logic is in
// handler.ts and takes a `Runtime`, so Vitest drives it with PGlite; this file only builds the
// real one. README.md says what it reads and writes.
import { connect, createClient } from "./client.ts";
import { handleRunApprove, type Runtime } from "./handler.ts";
import { runnerOf } from "./sql.ts";
import { SqlApproveStore } from "./store.ts";

type Env = (name: string) => string | undefined;

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
    store: new SqlApproveStore(runnerOf(connect(dbUrl))),
  };
}

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
      return handleRunApprove(req, runtime());
    } catch (err) {
      console.error("run-approve is misconfigured", err);
      return Response.json({ ok: false, error: "internal_error" }, { status: 500 });
    }
  },
};
