// WS15 fix round: the daily cap fails closed. When today's spend cannot be read (the lookup throws,
// or answers with something that is not a number) the call is refused with LlmError("cost_unknown"),
// an ai_runs refusal row says so, and the error is reported. Before, the guard let the call through
// with a console warning, which is exactly when an outage in ai_runs leaves nobody watching spend.
import { describe, expect, it, vi } from "vitest";
import { LlmError } from "./client.ts";
import { type AiRunRecord, CostUnknownError, createDailyCapGuard } from "./log.ts";

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

describe("when today's spend cannot be read (the cap fails closed)", () => {
  it("refuses the call, writes the refusal row, and reports it", async () => {
    const { rows, sink: record } = sink();
    const report = vi.fn();
    const warn = vi.fn();
    const cause = new Error("db down");
    const guard = createDailyCapGuard({
      capUsd: 2,
      spentTodayUsd: async () => {
        throw cause;
      },
      sink: record,
      report,
      onWarning: warn,
    });
    const refusal = await guard.check(HOUSEHOLD, CALL).catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(CostUnknownError);
    expect(refusal).toBeInstanceOf(LlmError);
    expect(refusal).toMatchObject({ code: "cost_unknown", name: "CostUnknownError", cause });
    expect(rows).toEqual([
      {
        householdId: HOUSEHOLD,
        kind: CALL.kind,
        model: CALL.model,
        promptVersion: CALL.promptVersion,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0,
        latencyMs: 0,
        ok: false,
        error: "cost_unknown",
      },
    ]);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(refusal);
    expect(warn).toHaveBeenCalledWith("daily cost lookup failed: db down");
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["text", "not a number"],
    ["undefined", undefined],
  ])("refuses the call when the spend comes back as %s", async (_name, answer) => {
    const { rows, sink: record } = sink();
    const guard = createDailyCapGuard({
      capUsd: 2,
      spentTodayUsd: async () => answer as unknown as number,
      sink: record,
    });
    await expect(guard.check(HOUSEHOLD, CALL)).rejects.toMatchObject({ code: "cost_unknown" });
    expect(rows.map((row) => row.error)).toEqual(["cost_unknown"]);
  });

  it("fails closed for a user's household-less calls too, with the user on the row", async () => {
    const { rows, sink: record } = sink();
    const guard = createDailyCapGuard({
      capUsd: 2,
      spentTodayUsd: async () => 0,
      userSpentTodayUsd: async () => {
        throw new Error("rpc missing");
      },
      sink: record,
    });
    await expect(guard.check(null, { ...CALL, userId: USER })).rejects.toMatchObject({
      code: "cost_unknown",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ householdId: null, userId: USER, error: "cost_unknown" });
  });

  it("still refuses when the report, or the refusal row, throws", async () => {
    const warn = vi.fn();
    const guard = createDailyCapGuard({
      capUsd: 2,
      spentTodayUsd: async () => {
        throw new Error("db down");
      },
      sink: () => {
        throw new Error("ai_runs down too");
      },
      report: () => {
        throw new Error("sentry down");
      },
      onWarning: warn,
    });
    await expect(guard.check(HOUSEHOLD, CALL)).rejects.toMatchObject({ code: "cost_unknown" });
    expect(warn).toHaveBeenCalledWith("ai_runs refusal row failed: ai_runs down too");
  });

  it("refuses with no call details too, and writes no row", async () => {
    const { rows, sink: record } = sink();
    const guard = createDailyCapGuard({
      capUsd: 2,
      spentTodayUsd: async () => {
        throw new Error("db down");
      },
      sink: record,
    });
    await expect(guard.check(HOUSEHOLD)).rejects.toMatchObject({ code: "cost_unknown" });
    expect(rows).toEqual([]);
  });

  it("leaves the rule for a cap that cannot be read alone: it falls back to the configured cap", async () => {
    const warn = vi.fn();
    const guard = createDailyCapGuard({
      capUsd: 2,
      capFor: async () => {
        throw new Error("households unreadable");
      },
      spentTodayUsd: async () => 0.5,
      onWarning: warn,
    });
    await expect(guard.check(HOUSEHOLD, CALL)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("household cap lookup failed: households unreadable");
  });

  it("leaves system jobs, which are not capped, alone", async () => {
    const spent = vi.fn(async () => {
      throw new Error("db down");
    });
    const guard = createDailyCapGuard({ capUsd: 2, spentTodayUsd: spent });
    await expect(guard.check(null, CALL)).resolves.toBeUndefined();
    expect(spent).not.toHaveBeenCalled();
  });
});
