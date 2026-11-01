// run-approve request handling (WS09). No Deno globals and no database driver here: the handler
// takes a `Runtime`, so Vitest drives it with PGlite and index.ts builds the real one.
//
//   POST { runId, decisions: [{ runItemId, action: keep | swap | remove | quantity,
//                               alternativeIndex?, quantity? }] }
//     -> { ok: true, runId, status: "running", subtotalUsd, itemCount }
//     or { ok: false, error, message }
//
// The order of work, and why (the list-build precedent):
//   1. Authenticate (auth.getUser on the bearer token) and validate the body.
//   2. Resolve the run's household and check the caller belongs to it, before reading the run.
//      Another household's run and a missing run both answer 403.
//   3. Apply the review and open the push phase in one transaction (store.ts).
import type { ReviewDecision } from "../../../packages/agent/src/review.ts";
import type { SqlApproveStore } from "./store.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/** Largest body accepted. Two hundred decisions fit well inside it. */
export const MAX_BODY_BYTES = 40_000;

export interface RunApproveRequest {
  runId: string;
  decisions: ReviewDecision[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIONS = new Set(["keep", "swap", "remove", "quantity"]);
const DECISION_KEYS = new Set(["runItemId", "action", "alternativeIndex", "quantity"]);

function intIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/** The request body, strictly: unknown keys, bad ids, or out-of-range numbers are refused. */
export function parseRunApproveRequest(raw: unknown): RunApproveRequest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== "runId" && key !== "decisions")) return null;
  if (typeof body.runId !== "string" || !UUID.test(body.runId)) return null;
  const list = body.decisions ?? [];
  if (!Array.isArray(list) || list.length > 200) return null;
  const decisions: ReviewDecision[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const d = entry as Record<string, unknown>;
    if (Object.keys(d).some((key) => !DECISION_KEYS.has(key))) return null;
    if (typeof d.runItemId !== "string" || !UUID.test(d.runItemId)) return null;
    if (typeof d.action !== "string" || !ACTIONS.has(d.action)) return null;
    if (d.alternativeIndex !== undefined && !intIn(d.alternativeIndex, 0, 2)) return null;
    if (d.quantity !== undefined && !intIn(d.quantity, 1, 24)) return null;
    decisions.push({
      runItemId: d.runItemId.toLowerCase(),
      action: d.action as ReviewDecision["action"],
      ...(d.alternativeIndex !== undefined
        ? { alternativeIndex: d.alternativeIndex as number }
        : {}),
      ...(d.quantity !== undefined ? { quantity: d.quantity as number } : {}),
    });
  }
  return { runId: body.runId.toLowerCase(), decisions };
}

export const RUN_APPROVE_ERRORS = {
  unauthorized: "Sign in again to approve this cart.",
  invalid_request: "That approval could not be read.",
  not_a_member: "This run is not in your household.",
  not_reviewable: "This cart is not waiting for review anymore.",
  invalid_decision: "One of your changes could not be applied. Refresh and try again.",
  over_budget: "This cart is over your budget. Remove items or lower quantities, then approve.",
  empty_cart: "Nothing is left to add. Keep at least one item, or cancel the run.",
  internal_error: "Something went wrong. Try again.",
} as const;
export type RunApproveError = keyof typeof RUN_APPROVE_ERRORS;

export interface Runtime {
  authenticate(authHeader: string): Promise<{ userId: string } | null>;
  store: Pick<SqlApproveStore, "resolveRun" | "approve">;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } });
}

function fail(error: RunApproveError, status: number): Response {
  return json({ ok: false, error, message: RUN_APPROVE_ERRORS[error] }, status);
}

export async function handleRunApprove(req: Request, runtime: Runtime): Promise<Response> {
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
    console.error("run-approve: auth check failed", err);
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
  const parsed = parseRunApproveRequest(raw);
  if (!parsed) return fail("invalid_request", 400);
  const { runId, decisions } = parsed;

  try {
    const membership = await runtime.store.resolveRun(user.userId, runId);
    if (membership.kind !== "member") return fail("not_a_member", 403);

    const result = await runtime.store.approve({
      runId,
      householdId: membership.householdId,
      userId: user.userId,
      decisions,
    });
    if (!result.ok) {
      const status = result.error === "invalid_decision" ? 400 : 409;
      return fail(result.error, status);
    }
    return json(result);
  } catch (err) {
    console.error("run-approve failed", err);
    return fail("internal_error", 500);
  }
}
