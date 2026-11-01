// WS15: the cost cap, from the guard's rules to what the three call paths do with a refusal.
// Acceptance criterion 4 (corrected 2026-10-31): with a household's cap at $0.01 the next call
// throws LlmError("cost_cap") before any network request, and an ai_runs row with ok false and
// error 'cost_cap' is written.
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { LlmError, type MessagesClient, type ParsedResponse } from "./client.ts";
import { embed } from "./embed.ts";
import { extract } from "./extract.ts";
import {
  type AiRunRecord,
  CostCapError,
  createDailyCapGuard,
  estimateInputCostUsd,
  toAiRunRow,
} from "./log.ts";
import { callWithTools, type ToolMessagesClient } from "./tool-call.ts";

const HOUSEHOLD = "0a000000-0000-4000-8000-00000000000a";
const USER = "a1111111-1111-4111-8111-111111111111";
const CALL = {
  kind: "extract_recipe",
  model: "claude-sonnet-5-5",
  promptVersion: "recipe-extract.v1",
};

function sink() {
  const rows: AiRunRecord[] = [];
  return { rows, sink: (row: AiRunRecord) => void rows.push(row) };
}

describe("the household's own cap", () => {
  it("uses the cap from the household row, not the fallback", async () => {
    const guard = createDailyCapGuard({
      capUsd: 2,
      capFor: async () => 0.01,
      spentTodayUsd: async () => 0.02,
    });
    await expect(guard.check(HOUSEHOLD, CALL)).rejects.toBeInstanceOf(CostCapError);
  });

  it("lets a household with a higher cap of its own through where the fallback would stop it", async () => {
    const guard = createDailyCapGuard({
      capUsd: 2,
      capFor: async () => 10,
      spentTodayUsd: async () => 5,
    });
    await expect(guard.check(HOUSEHOLD, CALL)).resolves.toBeUndefined();
  });

  it("falls back to the configured cap when the household has none or the lookup fails", async () => {
    const warn = vi.fn();
    const none = createDailyCapGuard({
      capUsd: 2,
      capFor: async () => null,
      spentTodayUsd: async () => 3,
    });
    await expect(none.check(HOUSEHOLD, CALL)).rejects.toMatchObject({ code: "cost_cap" });
    const broken = createDailyCapGuard({
      capUsd: 2,
      capFor: async () => {
        throw new Error("households unreadable");
      },
      spentTodayUsd: async () => 3,
      onWarning: warn,
    });
    await expect(broken.check(HOUSEHOLD, CALL)).rejects.toMatchObject({ code: "cost_cap" });
    expect(warn).toHaveBeenCalledWith("household cap lookup failed: households unreadable");
  });

  it("reads a numeric string from the database, and treats a cap of zero as no model calls", async () => {
    const asString = createDailyCapGuard({
      capUsd: 2,
      capFor: async () => "0.50" as unknown as number,
      spentTodayUsd: async () => 0.6,
    });
    await expect(asString.check(HOUSEHOLD, CALL)).rejects.toMatchObject({ code: "cost_cap" });
    const zero = createDailyCapGuard({
      capUsd: 2,
      capFor: async () => 0,
      spentTodayUsd: async () => 0,
    });
    await expect(zero.check(HOUSEHOLD, CALL)).rejects.toMatchObject({ code: "cost_cap" });
  });

  it("ignores a nonsense cap (negative, not a number) and uses the fallback", async () => {
    const guard = createDailyCapGuard({
      capUsd: 2,
      capFor: async () => -5,
      spentTodayUsd: async () => 1,
    });
    await expect(guard.check(HOUSEHOLD, CALL)).resolves.toBeUndefined();
  });
});

describe("the estimate", () => {
  it("refuses a call that would cross the cap, not only one made after it was crossed", async () => {
    // $1 spent of $1.001; the request is about 1M tokens of Sonnet input, $2 on its own.
    const guard = createDailyCapGuard({ capUsd: 1.001, spentTodayUsd: async () => 1 });
    const estimate = estimateInputCostUsd("claude-sonnet-5-5", 4_000_000);
    expect(estimate).toBeCloseTo(2, 6);
    await expect(guard.check(HOUSEHOLD, { ...CALL, estimatedCostUsd: estimate })).rejects.toThrow(
      /daily model budget of \$1\.00 reached/,
    );
    await expect(
      guard.check(HOUSEHOLD, { ...CALL, estimatedCostUsd: 0.0001 }),
    ).resolves.toBeUndefined();
  });

  it("prices the input at the model's rate", () => {
    expect(estimateInputCostUsd("claude-haiku-5-5", 4_000_000)).toBeCloseTo(0.1, 6);
    expect(estimateInputCostUsd("claude-opus-5-5", 4_000_000)).toBeCloseTo(4, 6);
    expect(estimateInputCostUsd("claude-sonnet-5-5", 0)).toBe(0);
  });
});

describe("a refusal is a row", () => {
  it("writes ok false and error 'cost_cap' before it throws, and says who and what", async () => {
    const { rows, sink: write } = sink();
    const guard = createDailyCapGuard({
      capUsd: 2,
      spentTodayUsd: async () => 2,
      sink: write,
    });
    const error = await guard
      .check(HOUSEHOLD, { ...CALL, runId: "0d000000-0000-4000-8000-00000000000d" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CostCapError);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ code: "cost_cap", scope: "household", capUsd: 2, spentUsd: 2 });
    expect(rows).toEqual([
      {
        householdId: HOUSEHOLD,
        kind: "extract_recipe",
        model: "claude-sonnet-5-5",
        promptVersion: "recipe-extract.v1",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0,
        latencyMs: 0,
        ok: false,
        error: "cost_cap",
        runId: "0d000000-0000-4000-8000-00000000000d",
      },
    ]);
    expect(toAiRunRow(rows[0] as AiRunRecord)).toMatchObject({
      household_id: HOUSEHOLD,
      ok: false,
      error: "cost_cap",
      cost_usd: 0,
    });
  });

  it("writes nothing when the caller did not say what the call was, and still throws", async () => {
    const { rows, sink: write } = sink();
    const guard = createDailyCapGuard({ capUsd: 1, spentTodayUsd: async () => 5, sink: write });
    await expect(guard.check(HOUSEHOLD)).rejects.toMatchObject({ code: "cost_cap" });
    expect(rows).toHaveLength(0);
  });

  it("throws the refusal even when the sink fails", async () => {
    const warn = vi.fn();
    const guard = createDailyCapGuard({
      capUsd: 1,
      spentTodayUsd: async () => 5,
      sink: () => {
        throw new Error("ai_runs down");
      },
      onWarning: warn,
    });
    await expect(guard.check(HOUSEHOLD, CALL)).rejects.toMatchObject({ code: "cost_cap" });
    expect(warn).toHaveBeenCalledWith("ai_runs refusal row failed: ai_runs down");
  });

  it("does not write a row for a call that is allowed", async () => {
    const { rows, sink: write } = sink();
    const guard = createDailyCapGuard({ capUsd: 5, spentTodayUsd: async () => 1, sink: write });
    await guard.check(HOUSEHOLD, CALL);
    expect(rows).toHaveLength(0);
  });
});

describe("a call with no household is capped per user", () => {
  it("refuses a user over the cap and records who", async () => {
    const { rows, sink: write } = sink();
    const spent = vi.fn(async () => 2.5);
    const guard = createDailyCapGuard({
      capUsd: 2,
      spentTodayUsd: async () => {
        throw new Error("a household lookup must not run for a user-only call");
      },
      userSpentTodayUsd: spent,
      sink: write,
    });
    const call = { kind: "parse_ingredients", model: "claude-haiku-5-5", userId: USER };
    await expect(guard.check(null, call)).rejects.toMatchObject({
      code: "cost_cap",
      scope: "user",
      capUsd: 2,
    });
    expect(spent).toHaveBeenCalledWith(USER);
    expect(rows[0]).toMatchObject({
      householdId: null,
      userId: USER,
      error: "cost_cap",
      ok: false,
    });
    expect(toAiRunRow(rows[0] as AiRunRecord)).toMatchObject({ household_id: null, user_id: USER });
  });

  it("uses userCapUsd when one is given, and lets a user under it through", async () => {
    const guard = createDailyCapGuard({
      capUsd: 2,
      userCapUsd: 0.5,
      spentTodayUsd: async () => 0,
      userSpentTodayUsd: async () => 0.4,
    });
    const call = { kind: "parse_ingredients", model: "claude-haiku-5-5", userId: USER };
    await expect(guard.check(null, call)).resolves.toBeUndefined();
    await expect(guard.check(null, { ...call, estimatedCostUsd: 0.2 })).rejects.toMatchObject({
      code: "cost_cap",
    });
  });

  it("does not cap a system job: no household and no user", async () => {
    const guard = createDailyCapGuard({
      capUsd: 0,
      spentTodayUsd: async () => 99,
      userSpentTodayUsd: async () => 99,
    });
    await expect(guard.check(null, { kind: "embed", model: "voyage-3" })).resolves.toBeUndefined();
    await expect(guard.check(null)).resolves.toBeUndefined();
  });
});

describe("the call paths stop before any request", () => {
  const Answer = z.object({ title: z.string() });

  it("extract: a cap of $0.01 with $0.02 spent throws and sends nothing", async () => {
    const parse = vi.fn(async (): Promise<ParsedResponse> => {
      throw new Error("the network must not be reached");
    });
    const client: MessagesClient = { messages: { parse } };
    const { rows, sink: write } = sink();
    const guard = createDailyCapGuard({
      capUsd: 2,
      capFor: async () => 0.01,
      spentTodayUsd: async () => 0.02,
      sink: write,
    });
    await expect(
      extract(
        Answer,
        {
          system: "You extract.",
          user: "A recipe",
          kind: "extract_recipe",
          promptVersion: "recipe-extract.v1",
          householdId: HOUSEHOLD,
        },
        { client, guard, log: write },
      ),
    ).rejects.toMatchObject({ code: "cost_cap" });
    expect(parse).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      householdId: HOUSEHOLD,
      kind: "extract_recipe",
      model: "claude-sonnet-5-5",
      promptVersion: "recipe-extract.v1",
      ok: false,
      error: "cost_cap",
      costUsd: 0,
    });
  });

  it("extract: a household-less call from a user over the user cap is stopped too", async () => {
    const parse = vi.fn();
    const { rows, sink: write } = sink();
    const guard = createDailyCapGuard({
      capUsd: 1,
      spentTodayUsd: async () => 0,
      userSpentTodayUsd: async () => 1,
      sink: write,
    });
    await expect(
      extract(
        Answer,
        { system: "s", user: "u", kind: "parse_ingredients", userId: USER },
        { client: { messages: { parse } }, guard },
      ),
    ).rejects.toMatchObject({ code: "cost_cap", scope: "user" });
    expect(parse).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ householdId: null, userId: USER, kind: "parse_ingredients" });
  });

  it("callWithTools: the same, before the Messages API is called", async () => {
    const create = vi.fn();
    const client: ToolMessagesClient = { messages: { create } };
    const { rows, sink: write } = sink();
    const guard = createDailyCapGuard({
      capUsd: 2,
      capFor: async () => 0.01,
      spentTodayUsd: async () => 0.01,
      sink: write,
    });
    await expect(
      callWithTools(
        {
          system: [{ type: "text", text: "s" }],
          messages: [{ role: "user", content: "hello" }],
          tools: [],
          kind: "agent_step",
          promptVersion: "agent-system.v1",
          householdId: HOUSEHOLD,
        },
        { client, guard, log: write },
      ),
    ).rejects.toMatchObject({ code: "cost_cap" });
    expect(create).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "agent_step", ok: false, error: "cost_cap" });
  });

  it("embed: the same, before the embedding service is called", async () => {
    const fetchSpy = vi.fn();
    const { rows, sink: write } = sink();
    const guard = createDailyCapGuard({
      capUsd: 2,
      capFor: async () => 0.01,
      spentTodayUsd: async () => 0.5,
      sink: write,
    });
    await expect(
      embed(["roast chicken"], {
        apiKey: "k",
        fetch: fetchSpy as unknown as typeof fetch,
        guard,
        householdId: HOUSEHOLD,
        kind: "suggest.embed",
        log: write,
      }),
    ).rejects.toMatchObject({ code: "cost_cap" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "suggest.embed", model: "voyage-3", error: "cost_cap" });
  });

  it("a call under its cap goes through, is logged once by the caller's sink, and writes no refusal", async () => {
    const parse = vi.fn(
      async (): Promise<ParsedResponse> => ({
        parsed_output: { title: "Soup" },
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 20 },
      }),
    );
    const { rows, sink: write } = sink();
    const guard = createDailyCapGuard({
      capUsd: 2,
      capFor: async () => 2,
      spentTodayUsd: async () => 0.1,
      sink: write,
    });
    const result = await extract(
      Answer,
      { system: "s", user: "u", kind: "extract_recipe", householdId: HOUSEHOLD },
      { client: { messages: { parse } }, guard, log: write },
    );
    expect(result.value).toEqual({ title: "Soup" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ok: true, error: null });
  });
});
