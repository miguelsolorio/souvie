// WS15 fix round: the daily cap is wired into recipe-import's real runtime. `runtimeFromEnv` builds
// the model path (`modelFor`) from the household's cap and spend, a sink that writes the refusal
// row, and `extract`. Until this test, taking the guard out of that call left every test green.
//
// Everything outside index.ts is stood in for: supabase-js (an `ai_runs` table that keeps its rows),
// the store (the household's cap and today's spend are numbers here), and the Anthropic client.
// The guard, `extract`, `logAiRun` and the sink are the real ones.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  cap: null as number | null,
  spent: (() => Promise.resolve(0)) as () => Promise<number>,
  parse: vi.fn(),
  reported: [] as Array<{ error: unknown; context: unknown }>,
}));

vi.mock("./client.ts", () => ({
  createClient: () => ({
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        if (table === "ai_runs") h.rows.push(row);
        return { error: null };
      },
    }),
  }),
}));
vi.mock("./store.ts", () => ({
  SupabaseImportStore: class {
    householdCapUsd = async () => h.cap;
    spentSince = async () => h.spent();
  },
}));
vi.mock("../../../packages/llm/src/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../packages/llm/src/index.ts")>()),
  createAnthropicClient: async () => ({ messages: { parse: h.parse } }),
}));
vi.mock("../_shared/sentry.ts", () => ({
  reportError: (error: unknown, context: unknown) => void h.reported.push({ error, context }),
}));

import { ReviewSummary } from "../../../packages/llm/src/index.ts";
import { runtimeFromEnv } from "./index.ts";

const HOUSEHOLD = "0a000000-0000-4000-8000-00000000000a";
const ENV: Record<string, string> = {
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_ANON_KEY: "anon-test-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-test-key",
  ANTHROPIC_API_KEY: "sk-ant-test-not-real-0000",
};
// Any zod schema will do for the model path; this one is the llm package's own.
const Answer = ReviewSummary;
const REQUEST = {
  system: "You extract.",
  user: "Input text",
  kind: "extract_recipe",
  promptVersion: "recipe-extract.v1",
};

function modelFor() {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const runtime = runtimeFromEnv((name) => ENV[name], { env: { get: (name) => ENV[name] } });
  const model = runtime.modelFor(HOUSEHOLD);
  if (!model) throw new Error("no model path");
  return model;
}

beforeEach(() => {
  h.rows.length = 0;
  h.reported.length = 0;
  h.cap = null;
  h.spent = async () => 0;
  h.parse.mockReset();
  h.parse.mockResolvedValue({
    parsed_output: { summary: "Soup" },
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 20 },
  });
});

describe("recipe-import's model path and the daily cap", () => {
  it("calls the model and logs the call when the household is under its cap", async () => {
    h.spent = async () => 0.1;
    const result = await modelFor()(Answer, REQUEST);
    expect(result.value).toEqual({ summary: "Soup" });
    expect(h.parse).toHaveBeenCalledTimes(1);
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({ household_id: HOUSEHOLD, kind: "extract_recipe", ok: true });
  });

  it("refuses before any request once the household has spent AI_DAILY_CAP_USD, and writes the refusal row", async () => {
    h.spent = async () => 5;
    await expect(modelFor()(Answer, REQUEST)).rejects.toMatchObject({ code: "cost_cap" });
    expect(h.parse).not.toHaveBeenCalled();
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({
      household_id: HOUSEHOLD,
      kind: "extract_recipe",
      ok: false,
      error: "cost_cap",
      cost_usd: 0,
    });
  });

  it("uses the household's own cap, read from the store, where it is lower", async () => {
    h.cap = 0.01;
    h.spent = async () => 0.02;
    await expect(modelFor()(Answer, REQUEST)).rejects.toMatchObject({ code: "cost_cap" });
    expect(h.parse).not.toHaveBeenCalled();
  });

  it("refuses with cost_unknown, and reports it, when today's spend cannot be read", async () => {
    h.spent = async () => {
      throw new Error("household_ai_spend_since failed: rpc down");
    };
    await expect(modelFor()(Answer, REQUEST)).rejects.toMatchObject({ code: "cost_unknown" });
    expect(h.parse).not.toHaveBeenCalled();
    expect(h.rows.map((row) => row.error)).toEqual(["cost_unknown"]);
    expect(h.reported).toHaveLength(1);
    expect(h.reported[0]?.context).toEqual({ function: "recipe-import", householdId: HOUSEHOLD });
  });
});
