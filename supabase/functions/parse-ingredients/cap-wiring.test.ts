// WS15 fix round: the daily cap is wired into parse-ingredients' real runtime. `createRun` builds
// the guard (the household's cap, the household's spend, the user's spend, the refusal sink),
// wraps the Haiku client with it for this household and this user, and records the model calls in
// `finish()` with the user when there is no household. Five separate mistakes in that function
// left every test green until this file (the WS03 review cared about the "lines" mode, where the
// user is all the cap has to count):
//   1. the model is not wrapped by `withCostGuard`
//   2. the handler does not pass the user in "lines" mode (index.test.ts covers the handler)
//   3. ... or in "recipe" mode (index.test.ts)
//   4. the user's spend reader (`userSpentTodayUsd`) is missing from the guard
//   5. `finish()` does not write `user_id` on a household-less call
//
// Stood in for: supabase-js (rpc answers and an `ai_runs` table that keeps its rows) and the Haiku
// client. The guard, `withCostGuard`, `SupabaseSpendStore`, `logAiRun` and `recordAiRun` are real.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  /** What each spend function answers: a number, or an Error to answer with an rpc error. */
  spend: { household: 0 as number | Error, user: 0 as number | Error },
  cap: null as number | null,
  reported: [] as Array<{ error: unknown; context: unknown }>,
  parseBatch: vi.fn(),
}));

vi.mock("./client.ts", () => ({
  createClient: () => ({
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        if (table === "ai_runs") h.rows.push(row);
        return { error: null };
      },
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { ai_daily_cap_usd: h.cap }, error: null }),
        }),
      }),
    }),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      h.rpcCalls.push({ fn, args });
      const answer = fn === "user_ai_spend_since" ? h.spend.user : h.spend.household;
      return answer instanceof Error
        ? { data: null, error: { message: answer.message } }
        : { data: answer, error: null };
    },
  }),
}));
vi.mock("../../../packages/ingredient-parser/src/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../packages/ingredient-parser/src/index.ts")>()),
  createAnthropicParseClient: () => ({
    model: "claude-haiku-5-5",
    promptVersion: "ingredient-parse.v1",
    parseBatch: h.parseBatch,
  }),
}));
vi.mock("../_shared/sentry.ts", () => ({
  reportError: (error: unknown, context: unknown) => void h.reported.push({ error, context }),
}));

import type { LlmUsage } from "../../../packages/ingredient-parser/src/index.ts";
import { runtimeFromEnv } from "./index.ts";

const USER = "a1111111-1111-4111-8111-111111111111";
const HOUSEHOLD = "0a000000-0000-4000-8000-00000000000a";
const ENV: Record<string, string> = {
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_ANON_KEY: "anon-test-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-test-key",
  ANTHROPIC_API_KEY: "sk-ant-test-not-real-0000",
};
const USAGE: LlmUsage = {
  model: "claude-haiku-5-5",
  promptVersion: "ingredient-parse.v1",
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 0,
  latencyMs: 12,
  ok: true,
  lines: 1,
};

function createRun(householdId: string | null, userId: string | null) {
  const runtime = runtimeFromEnv((name) => ENV[name]);
  return runtime.createRun(householdId, userId);
}

function llmOf(run: ReturnType<typeof createRun>) {
  const llm = run.deps.llm;
  if (!llm) throw new Error("the run has no model");
  return llm;
}

beforeEach(() => {
  h.rows.length = 0;
  h.rpcCalls.length = 0;
  h.reported.length = 0;
  h.spend.household = 0;
  h.spend.user = 0;
  h.cap = null;
  h.parseBatch.mockReset();
  h.parseBatch.mockResolvedValue({ byIndex: new Map(), usage: USAGE });
});

describe('the "lines" mode: no household, so the cap counts the user', () => {
  it("refuses a user over the daily cap before the model, with the user on the refusal row", async () => {
    h.spend.user = 5;
    const run = createRun(null, USER);
    await expect(llmOf(run).parseBatch(["1 cup flour"])).rejects.toMatchObject({
      code: "cost_cap",
      scope: "user",
    });
    expect(h.parseBatch).not.toHaveBeenCalled();
    expect(h.rpcCalls).toEqual([
      { fn: "user_ai_spend_since", args: { p_user_id: USER, p_since: expect.any(String) } },
    ]);
    expect(h.rows).toEqual([
      expect.objectContaining({
        household_id: null,
        user_id: USER,
        kind: "parse_ingredients",
        ok: false,
        error: "cost_cap",
        cost_usd: 0,
      }),
    ]);
  });

  it("lets a user under the cap through, and finish() records the call with the user", async () => {
    h.spend.user = 0.1;
    const run = createRun(null, USER);
    await llmOf(run).parseBatch(["1 cup flour"]);
    expect(h.parseBatch).toHaveBeenCalledTimes(1);
    run.deps.onLlmRun?.(USAGE);
    await run.finish();
    expect(h.rows).toEqual([
      expect.objectContaining({
        household_id: null,
        user_id: USER,
        kind: "parse_ingredients",
        ok: true,
      }),
    ]);
  });

  it("refuses with cost_unknown, and reports it, when the user's spend cannot be read", async () => {
    h.spend.user = new Error("rpc down");
    const run = createRun(null, USER);
    await expect(llmOf(run).parseBatch(["1 cup flour"])).rejects.toMatchObject({
      code: "cost_unknown",
    });
    expect(h.parseBatch).not.toHaveBeenCalled();
    expect(h.rows.map((row) => row.error)).toEqual(["cost_unknown"]);
    expect(h.reported).toHaveLength(1);
    expect(h.reported[0]?.context).toEqual({ function: "parse-ingredients", householdId: null });
  });
});

describe('the "recipe" mode: the household\'s cap and spend', () => {
  it("refuses a household over its daily cap, and never reads the user's spend", async () => {
    h.spend.household = 5;
    const run = createRun(HOUSEHOLD, USER);
    await expect(llmOf(run).parseBatch(["1 cup flour"])).rejects.toMatchObject({
      code: "cost_cap",
      scope: "household",
    });
    expect(h.parseBatch).not.toHaveBeenCalled();
    expect(h.rpcCalls.map((call) => call.fn)).toEqual(["household_ai_spend_since"]);
    expect(h.rows).toEqual([
      expect.objectContaining({ household_id: HOUSEHOLD, error: "cost_cap", ok: false }),
    ]);
  });

  it("uses the household's own cap, read from households.ai_daily_cap_usd", async () => {
    h.cap = 0.01;
    h.spend.household = 0.02;
    const run = createRun(HOUSEHOLD, USER);
    await expect(llmOf(run).parseBatch(["1 cup flour"])).rejects.toMatchObject({
      code: "cost_cap",
    });
    expect(h.parseBatch).not.toHaveBeenCalled();
  });

  it("records a call with the household and no user", async () => {
    const run = createRun(HOUSEHOLD, USER);
    await llmOf(run).parseBatch(["1 cup flour"]);
    run.deps.onLlmRun?.(USAGE);
    await run.finish();
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({ household_id: HOUSEHOLD, ok: true });
    expect(h.rows[0]).not.toHaveProperty("user_id");
  });
});
