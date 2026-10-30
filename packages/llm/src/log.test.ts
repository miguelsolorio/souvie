import { describe, expect, it, vi } from "vitest";
import {
  type AiRunRecord,
  createDailyCapGuard,
  estimateCostUsd,
  logAiRun,
  toAiRunRow,
} from "./log.ts";

const RECORD: AiRunRecord = {
  householdId: "0a000000-0000-4000-8000-00000000000a",
  kind: "extract_recipe",
  model: "claude-sonnet-5-5",
  promptVersion: "recipe-extract.v1",
  inputTokens: 1200,
  outputTokens: 300,
  cacheReadTokens: 500,
  costUsd: 0.005,
  latencyMs: 2400,
  ok: true,
  error: null,
};

describe("estimateCostUsd", () => {
  it("prices Sonnet 5.5 at $2 in and $10 out per million tokens", () => {
    expect(estimateCostUsd("claude-sonnet-5-5", { inputTokens: 1_000_000, outputTokens: 0 })).toBe(
      2,
    );
    expect(estimateCostUsd("claude-sonnet-5-5", { inputTokens: 0, outputTokens: 1_000_000 })).toBe(
      10,
    );
  });

  it("prices Haiku and Opus from the same table", () => {
    expect(
      estimateCostUsd("claude-haiku-5-5", { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    ).toBe(0.6);
    expect(
      estimateCostUsd("claude-opus-5-5", { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    ).toBe(24);
  });

  it("bills cache reads at a fraction and cache writes at 1.25x", () => {
    expect(
      estimateCostUsd("claude-sonnet-5-5", {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
      }),
    ).toBeCloseTo(0.2, 8);
    expect(
      estimateCostUsd("claude-sonnet-5-5", {
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 1_000_000,
      }),
    ).toBeCloseTo(2.5, 8);
  });

  it("never prices an unknown model as free", () => {
    expect(estimateCostUsd("claude-future-9", { inputTokens: 1_000_000, outputTokens: 0 })).toBe(2);
  });
});

describe("toAiRunRow", () => {
  it("maps to the ai_runs columns and caps the error text", () => {
    const row = toAiRunRow({ ...RECORD, ok: false, error: "x".repeat(900) });
    expect(row).toMatchObject({
      household_id: "0a000000-0000-4000-8000-00000000000a",
      kind: "extract_recipe",
      model: "claude-sonnet-5-5",
      prompt_version: "recipe-extract.v1",
      input_tokens: 1200,
      output_tokens: 300,
      cache_read_tokens: 500,
      cost_usd: 0.005,
      latency_ms: 2400,
      ok: false,
    });
    expect(row.error).toHaveLength(500);
  });
});

describe("logAiRun", () => {
  it("inserts one row", async () => {
    const insert = vi.fn(async () => ({ error: null }));
    await logAiRun({ insert }, RECORD);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ kind: "extract_recipe" }));
  });

  it("warns instead of throwing when the insert fails", async () => {
    const warn = vi.fn();
    await logAiRun(
      { insert: async () => ({ error: { message: "relation does not exist" } }) },
      RECORD,
      warn,
    );
    expect(warn).toHaveBeenCalledWith("ai_runs insert failed: relation does not exist");

    const warn2 = vi.fn();
    await logAiRun(
      {
        insert: () => {
          throw new Error("network down");
        },
      },
      RECORD,
      warn2,
    );
    expect(warn2).toHaveBeenCalledWith("ai_runs insert failed: network down");
  });
});

describe("createDailyCapGuard", () => {
  it("lets a household under its cap through and stops one at or over it", async () => {
    const spent = vi.fn(async (id: string) => (id === "under" ? 0.5 : 2));
    const guard = createDailyCapGuard({ capUsd: 2, spentTodayUsd: spent });
    await expect(guard.check("under")).resolves.toBeUndefined();
    await expect(guard.check("over")).rejects.toMatchObject({ code: "cost_cap" });
  });

  it("does not cap system jobs", async () => {
    const spent = vi.fn(async () => 999);
    const guard = createDailyCapGuard({ capUsd: 1, spentTodayUsd: spent });
    await expect(guard.check(null)).resolves.toBeUndefined();
    expect(spent).not.toHaveBeenCalled();
  });

  it("lets the call through, with a warning, when the spend lookup fails", async () => {
    const warn = vi.fn();
    const guard = createDailyCapGuard({
      capUsd: 1,
      spentTodayUsd: async () => {
        throw new Error("db down");
      },
      onWarning: warn,
    });
    await expect(guard.check("h")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("daily cost lookup failed: db down");
  });
});
