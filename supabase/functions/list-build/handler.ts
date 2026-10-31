// list-build request handling (WS05). No Deno globals and no database driver here: the handler takes
// a `Runtime`, so Vitest drives it with PGlite and fakes (handler.test.ts) and index.ts builds the
// real one. Request and response shapes are in @mp/core (list/types.ts) and README.md.
//
// The order of work, and why:
//   1. Authenticate and validate the request.
//   2. Resolve the household and check the caller belongs to it. Everything later uses the
//      household id from that check, never a second reading of the request.
//   3. Build the list in one transaction (store.ts).
import {
  LIST_BUILD_ERROR_MESSAGES,
  type ListBuildErrorCode,
  ListBuildRequest,
} from "../../../packages/core/src/index.ts";
import { NoPlanError, type SqlListStore } from "./store.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/** Largest request body accepted, in bytes. A real one is under 100. */
export const MAX_BODY_BYTES = 2_000;

export interface Runtime {
  authenticate(authHeader: string): Promise<{ userId: string } | null>;
  store: Pick<SqlListStore, "resolveHousehold" | "build">;
  now(): Date;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } });
}

function fail(error: ListBuildErrorCode, status: number): Response {
  return json({ ok: false, error, message: LIST_BUILD_ERROR_MESSAGES[error] }, status);
}

export async function handleListBuild(req: Request, runtime: Runtime): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") {
    return Response.json(
      { ok: false, error: "method_not_allowed" },
      { status: 405, headers: { ...CORS_HEADERS, Allow: "POST, OPTIONS" } },
    );
  }

  const authHeader = req.headers.get("authorization");
  if (!authHeader || !/^Bearer\s+\S+/i.test(authHeader)) return fail("unauthorized", 401);
  let user: { userId: string } | null = null;
  try {
    user = await runtime.authenticate(authHeader);
  } catch (err) {
    console.error("list-build: auth check failed", err);
  }
  if (!user) return fail("unauthorized", 401);

  let raw: unknown;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return fail("invalid_request", 413);
    raw = JSON.parse(text);
  } catch {
    return fail("invalid_request", 400);
  }
  const parsed = ListBuildRequest.safeParse(raw);
  if (!parsed.success) return fail("invalid_request", 400);
  const { weekStart, householdId } = parsed.data;

  try {
    const membership = await runtime.store.resolveHousehold(user.userId, householdId);
    if (membership.kind === "not_a_member") return fail("not_a_member", 403);
    if (membership.kind === "no_household") return fail("no_household", 403);

    const result = await runtime.store.build({
      householdId: membership.householdId,
      weekStart,
      now: runtime.now(),
    });
    return json(result);
  } catch (err) {
    // A week nobody planned is an outcome the app handles, not a failure of the request.
    if (err instanceof NoPlanError) return fail("no_plan", 200);
    // The body carries no internal detail; the log has it.
    console.error("list-build failed", err);
    return fail("internal_error", 500);
  }
}
