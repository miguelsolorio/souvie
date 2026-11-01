// parse-ingredients (WS03): turns free-text ingredient lines into structured rows.
//
//   POST { "lines": ["2 cups diced yellow onion", ...] }   -> { results: ParsedIngredient[][], meta }
//   POST { "recipeId": "<uuid>" }                          -> fills recipe_ingredients, returns counts
//
// Needs a signed-in user (verify_jwt stays on). Request shapes, limits, and column mapping are in
// README.md. The handler takes its collaborators as a `Runtime`, so Vitest drives it with fakes
// (index.test.ts). No Deno globals at import time.

import type { ParsedIngredient } from "../../../packages/core/src/index.ts";
import {
  createAnthropicParseClient,
  estimateCostUsd,
  type LlmUsage,
  type ParserDeps,
  parseLinesGrouped,
} from "../../../packages/ingredient-parser/src/index.ts";
import { createDailyCapGuard, logAiRun } from "../../../packages/llm/src/index.ts";
import { reportError } from "../_shared/sentry.ts";
import { createClient } from "./client.ts";
import { withCostGuard } from "./cost-guard.ts";
import {
  type RecipeStore,
  type RowInsert,
  type RowUpdate,
  type RowValues,
  recordAiRun,
  SupabaseOntologyStore,
  SupabaseParseCache,
  SupabaseProposalSink,
  SupabaseRecipeStore,
  SupabaseSpendStore,
} from "./store.ts";

export const MAX_LINES = 200;
export const MAX_LINE_LENGTH = 500;
const LOW_CONFIDENCE = 0.8;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/** One request's parser wiring. `finish` records the model calls it saw. */
export interface Run {
  deps: ParserDeps;
  usages: LlmUsage[];
  hasModel: boolean;
  finish(): Promise<void>;
}

export interface Runtime {
  authenticate(authHeader: string): Promise<{ userId: string } | null>;
  recipes: RecipeStore;
  /**
   * `userId` is the signed-in caller. The daily cap counts it when there is no household (the
   * "lines" mode), so one user cannot send 200 lines per call all day (WS03 review, WS15).
   */
  createRun(householdId: string | null, userId?: string | null): Run;
}

type Env = (name: string) => string | undefined;

/** USD a household (or, with no household, a user) may spend on model calls per UTC day. */
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
export function runtimeFromEnv(env: Env): Runtime {
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

  return {
    async authenticate(authHeader) {
      const token = authHeader.replace(/^Bearer\s+/i, "");
      const { data, error } = await serviceDb.auth.getUser(token);
      return error || !data.user ? null : { userId: data.user.id };
    },
    recipes: new SupabaseRecipeStore(userClient),
    createRun(householdId, userId = null) {
      const usages: LlmUsage[] = [];
      const spend = new SupabaseSpendStore(serviceDb);
      const guard = createDailyCapGuard({
        capUsd: dailyCap(env),
        capFor: (id) => spend.householdCapUsd(id),
        spentTodayUsd: (id) => spend.householdSpentSince(id, startOfUtcDay(new Date())),
        userSpentTodayUsd: (id) => spend.userSpentSince(id, startOfUtcDay(new Date())),
        sink: (record) => logAiRun(serviceDb.from("ai_runs"), record),
      });
      const model = anthropicKey ? createAnthropicParseClient({ apiKey: anthropicKey }) : undefined;
      const llm = model ? withCostGuard(model, guard, { householdId, userId }) : undefined;
      const deps: ParserDeps = {
        ontology: new SupabaseOntologyStore(serviceDb),
        cache: new SupabaseParseCache(serviceDb),
        proposals: new SupabaseProposalSink(serviceDb, householdId),
        onLlmRun: (usage) => {
          usages.push(usage);
        },
        onLlmError: (err) => console.warn("parse-ingredients: model call failed", err),
        ...(llm ? { llm } : {}),
      };
      return {
        deps,
        usages,
        hasModel: llm !== undefined,
        async finish() {
          for (const usage of usages)
            await recordAiRun(
              serviceDb,
              usage,
              estimateCostUsd(usage),
              householdId,
              householdId === null ? userId : null,
            );
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

type Body =
  | { kind: "lines"; lines: string[] }
  | { kind: "recipe"; recipeId: string }
  | { kind: "error"; error: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readBody(input: unknown): Body {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return { kind: "error", error: "body_must_be_an_object" };
  const { lines, recipeId } = input as { lines?: unknown; recipeId?: unknown };
  if (lines !== undefined && recipeId !== undefined)
    return { kind: "error", error: "send_lines_or_recipeId_not_both" };
  if (recipeId !== undefined) {
    return typeof recipeId === "string" && UUID_RE.test(recipeId)
      ? { kind: "recipe", recipeId }
      : { kind: "error", error: "recipeId_must_be_a_uuid" };
  }
  if (lines !== undefined) {
    if (!Array.isArray(lines) || !lines.every((l) => typeof l === "string"))
      return { kind: "error", error: "lines_must_be_strings" };
    if (lines.length === 0) return { kind: "error", error: "lines_must_not_be_empty" };
    if (lines.length > MAX_LINES)
      return { kind: "error", error: `too_many_lines_max_${MAX_LINES}` };
    if (lines.some((l) => l.length > MAX_LINE_LENGTH))
      return { kind: "error", error: `line_too_long_max_${MAX_LINE_LENGTH}` };
    return { kind: "lines", lines };
  }
  return { kind: "error", error: "send_lines_or_recipeId" };
}

export function rowValues(p: ParsedIngredient): RowValues {
  return {
    // docs/02: `qty` is the lower bound of a range and `qty_max` the upper bound (null otherwise).
    qty: p.qty,
    qty_max: p.qtyMax ?? null,
    unit: p.unit,
    ingredient_id: p.ingredientId,
    prep_note: p.prepNote ?? null,
    optional: p.optional,
    parse_confidence: p.confidence,
  };
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } });
}

function summarize(grouped: readonly ParsedIngredient[][]) {
  const items = grouped.flat();
  return {
    ingredients: items.length,
    lowConfidence: items.filter((i) => i.confidence < LOW_CONFIDENCE).length,
    unresolved: items.filter((i) => i.ingredientId === null).length,
  };
}

export async function handleParseIngredients(req: Request, runtime: Runtime): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") {
    return Response.json(
      { ok: false, error: "method_not_allowed" },
      { status: 405, headers: { ...CORS_HEADERS, Allow: "POST, OPTIONS" } },
    );
  }

  const authHeader = req.headers.get("authorization");
  if (!authHeader || !/^Bearer\s+\S+/i.test(authHeader))
    return json({ ok: false, error: "unauthorized" }, 401);
  let user: { userId: string } | null = null;
  try {
    user = await runtime.authenticate(authHeader);
  } catch (err) {
    console.error("parse-ingredients: auth check failed", err);
  }
  if (!user) return json({ ok: false, error: "unauthorized" }, 401);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }
  const body = readBody(raw);
  if (body.kind === "error") return json({ ok: false, error: body.error }, 400);

  try {
    if (body.kind === "lines") {
      const run = runtime.createRun(null, user.userId);
      const results = await parseLinesGrouped(body.lines, run.deps);
      await run.finish();
      return json({
        ok: true,
        results,
        meta: {
          ...summarize(results),
          modelCalls: run.usages.length,
          modelAvailable: run.hasModel,
        },
      });
    }

    const recipe = await runtime.recipes.load(authHeader, body.recipeId);
    if (!recipe) return json({ ok: false, error: "recipe_not_found" }, 404);
    if (recipe.rows.length === 0) {
      return json({
        ok: true,
        recipeId: body.recipeId,
        parsedRows: 0,
        ingredients: 0,
        lowConfidence: 0,
        unresolved: 0,
        modelCalls: 0,
      });
    }

    const run = runtime.createRun(recipe.householdId, user.userId);
    const grouped = await parseLinesGrouped(
      recipe.rows.map((r) => r.rawText),
      run.deps,
    );
    const updates: RowUpdate[] = [];
    const inserts: RowInsert[] = [];
    recipe.rows.forEach((row, i) => {
      const items = grouped[i] ?? [];
      const [first, ...rest] = items;
      if (first) updates.push({ id: row.id, ...rowValues(first) });
      for (const extra of rest) {
        inserts.push({
          recipe_id: body.recipeId,
          position: row.position,
          group_name: row.groupName,
          raw_text: row.rawText,
          ...rowValues(extra),
        });
      }
    });
    await runtime.recipes.save(authHeader, body.recipeId, updates, inserts);
    await run.finish();
    return json({
      ok: true,
      recipeId: body.recipeId,
      parsedRows: recipe.rows.length,
      ...summarize(grouped),
      modelCalls: run.usages.length,
    });
  } catch (err) {
    console.error("parse-ingredients failed", err);
    reportError(err, { function: "parse-ingredients" });
    return json({ ok: false, error: "internal_error" }, 500);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

let cached: Runtime | undefined;

function runtime(): Runtime {
  if (!cached) {
    const deno = (globalThis as { Deno?: { env: { get(name: string): string | undefined } } }).Deno;
    cached = runtimeFromEnv((name) => deno?.env.get(name));
  }
  return cached;
}

export default {
  fetch(req: Request): Promise<Response> | Response {
    try {
      return handleParseIngredients(req, runtime());
    } catch (err) {
      console.error("parse-ingredients is misconfigured", err);
      return json({ ok: false, error: "misconfigured" }, 500);
    }
  },
};
