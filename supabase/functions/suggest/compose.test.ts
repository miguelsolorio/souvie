// WS06 criteria 7, 8, and 9 (the composition half): the model's answer is validated against
// ComposedWeek and the candidate list, an out-of-range recipeIndex is rejected and retried once and
// then fails with a typed error, and every model call is logged. The model is a fake
// MessagesClient; the real `extract` runs, so the retry behaviour is the shipped behaviour.
import { describe, expect, it, vi } from "vitest";
import {
  type AiRunRecord,
  LlmError,
  type MessagesClient,
  SUGGEST_COMPOSE_V1,
} from "../../../packages/llm/src/index.ts";
import type { Candidate } from "./candidates.ts";
import {
  ComposeError,
  type ComposeInput,
  checkComposed,
  composeWeek,
  fallbackWeek,
} from "./compose.ts";

const DATES = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"];

function candidate(i: number, overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: `c77e0000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    householdId: "0a000000-0000-4000-8000-00000000000a",
    visibility: "household",
    title: `Recipe ${i}`,
    description: null,
    imageUrl: null,
    cuisine: ["italian", "mexican", "thai", "indian"][i % 4] ?? null,
    tags: ["dinner"],
    servings: 4,
    totalMin: 20 + i,
    similarity: null,
    score: 1 - i / 100,
    mainIngredients: [`ingredient ${i}`],
    ...overrides,
  };
}

const CANDIDATES = Array.from({ length: 12 }, (_, i) => candidate(i));

const INPUT: ComposeInput = {
  weekStart: "2026-11-02",
  dates: DATES,
  candidates: CANDIDATES,
  profile: { portions: 4, cuisines: ["thai"], diets: [], equipment: [] },
  lastWeek: [],
};

function entry(recipeIndex: number, date: string, why = "Quick and easy on a school night.") {
  return { recipeIndex, date, servings: 4, why };
}

function goodWeek() {
  return { entries: DATES.map((date, i) => entry(i * 2, date)), notes: "Cilantro carries over." };
}

function fakeClient(...answers: unknown[]) {
  const queue = [...answers];
  const parse = vi.fn(async (_params: Record<string, unknown>) => {
    const next = queue.shift();
    if (next === undefined) throw new Error("the fake model has no more answers");
    return {
      parsed_output: next,
      stop_reason: "end_turn",
      usage: { input_tokens: 1200, output_tokens: 300 },
    };
  });
  const client: MessagesClient = { messages: { parse } };
  return { client, parse };
}

describe("checkComposed", () => {
  const context = { candidateCount: 12, dates: DATES };
  const week = (entries: ReturnType<typeof entry>[]) => ({ entries, notes: "" });

  it("accepts a complete, distinct week", () => {
    expect(checkComposed(goodWeek(), context)).toBeNull();
  });

  it("rejects a recipeIndex past the end of the list", () => {
    const problem = checkComposed(
      week([entry(12, DATES[0] as string), ...DATES.slice(1).map((d, i) => entry(i, d))]),
      context,
    );
    expect(problem).toMatch(/recipeIndex 12 is out of range/);
  });

  it("rejects a repeated recipe, a repeated date, an unoffered date, and the wrong count", () => {
    const base = DATES.map((d, i) => entry(i, d));
    expect(
      checkComposed(week([...base.slice(0, 4), entry(0, DATES[4] as string)]), context),
    ).toMatch(/used twice/);
    expect(
      checkComposed(week([...base.slice(0, 4), entry(9, DATES[3] as string)]), context),
    ).toMatch(/date 2026-11-05 is used twice/);
    expect(checkComposed(week([...base.slice(0, 4), entry(9, "2026-11-09")]), context)).toMatch(
      /not one of the dates offered/,
    );
    expect(checkComposed(week(base.slice(0, 4)), context)).toMatch(
      /4 dinners but 5 were requested/,
    );
  });
});

describe("composeWeek", () => {
  it("returns five distinct recipes on five distinct dates, with ids read from the candidates (criterion 7)", async () => {
    const { client } = fakeClient(goodWeek());
    const result = await composeWeek(INPUT, { client, householdId: "h" });
    expect(result.entries).toHaveLength(5);
    expect(new Set(result.entries.map((e) => e.recipeId)).size).toBe(5);
    expect(new Set(result.entries.map((e) => e.date)).size).toBe(5);
    expect(result.entries.map((e) => e.date)).toEqual(DATES);
    for (const e of result.entries) {
      expect(CANDIDATES.some((c) => c.id === e.recipeId)).toBe(true);
      expect(e.why.length).toBeLessThan(140);
    }
    expect(result.entries[1]?.recipeId).toBe(CANDIDATES[2]?.id);
    expect(result.notes).toBe("Cilantro carries over.");
    expect(result.attempts).toBe(1);
  });

  it("sends Sonnet the numbered candidates and the dates, with the system prompt as the stable block", async () => {
    const { client, parse } = fakeClient(goodWeek());
    await composeWeek(INPUT, { client, householdId: "h" });
    const params = parse.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.model).toBe("claude-sonnet-5-5");
    const system = params.system as { text: string; cache_control: unknown }[];
    expect(system[0]?.text).toBe(SUGGEST_COMPOSE_V1.system());
    expect(system[0]?.cache_control).toEqual({ type: "ephemeral" });
    const content = (params.messages as { content: string }[])[0]?.content ?? "";
    expect(content).toContain("[0] Recipe 0");
    expect(content).toContain("[11] Recipe 11");
    expect(content).toContain(DATES.join(", "));
    expect(params.thinking).toBeUndefined();
    expect(params.temperature).toBeUndefined();
  });

  it("retries once when recipeIndex is out of range, and tells the model why (criterion 8)", async () => {
    const bad = goodWeek();
    bad.entries[2] = entry(99, DATES[2] as string);
    const { client, parse } = fakeClient(bad, goodWeek());
    const result = await composeWeek(INPUT, { client, householdId: "h" });
    expect(parse).toHaveBeenCalledTimes(2);
    expect(result.attempts).toBe(2);
    const retryParams = parse.mock.calls[1]?.[0] as { messages: { content: string }[] } | undefined;
    const retry = retryParams?.messages[0]?.content;
    expect(retry).toMatch(/recipeIndex 99 is out of range; use 0 to 11/);
  });

  it("fails with a typed error after the second bad answer (criterion 8)", async () => {
    const bad = goodWeek();
    bad.entries[0] = entry(12, DATES[0] as string);
    const { client, parse } = fakeClient(bad, bad);
    const error = await composeWeek(INPUT, { client, householdId: "h" }).catch((e) => e);
    expect(error).toBeInstanceOf(ComposeError);
    expect(error.code).toBe("invalid_output");
    expect(error.message).toMatch(/out of range/);
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("rejects an answer that is not the shape ComposedWeek describes", async () => {
    const { client } = fakeClient({ entries: [{ recipeIndex: "first" }] }, { nope: true });
    await expect(composeWeek(INPUT, { client, householdId: "h" })).rejects.toMatchObject({
      code: "invalid_output",
    });
  });

  it("rejects a reason over 139 characters", async () => {
    const long = goodWeek();
    long.entries[0] = entry(0, DATES[0] as string, "x".repeat(140));
    const { client } = fakeClient(long, long);
    await expect(composeWeek(INPUT, { client, householdId: "h" })).rejects.toMatchObject({
      code: "invalid_output",
    });
  });

  it("logs every model call to ai_runs as suggest.compose with tokens and cost (criterion 9)", async () => {
    const bad = goodWeek();
    bad.entries[0] = entry(40, DATES[0] as string);
    const { client } = fakeClient(bad, goodWeek());
    const runs: AiRunRecord[] = [];
    await composeWeek(INPUT, {
      client,
      householdId: "0a000000-0000-4000-8000-00000000000a",
      log: (run) => {
        runs.push(run);
      },
    });
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.ok)).toEqual([false, true]);
    for (const run of runs) {
      expect(run).toMatchObject({
        kind: "suggest.compose",
        model: "claude-sonnet-5-5",
        promptVersion: "suggest-compose.v1",
        householdId: "0a000000-0000-4000-8000-00000000000a",
        inputTokens: 1200,
        outputTokens: 300,
      });
      expect(run.costUsd).toBeGreaterThan(0);
    }
  });

  it("maps a missing key to not_configured and an exhausted budget to cost_cap", async () => {
    await expect(composeWeek(INPUT, { householdId: "h" })).rejects.toMatchObject({
      code: "not_configured",
    });
    const { client, parse } = fakeClient(goodWeek());
    const guard = {
      check: async () => {
        throw new LlmError("cost_cap", "over budget");
      },
    };
    await expect(composeWeek(INPUT, { client, guard, householdId: "h" })).rejects.toMatchObject({
      code: "cost_cap",
    });
    expect(parse).not.toHaveBeenCalled();
  });

  it("maps a model that keeps failing to model_failed", async () => {
    const parse = vi.fn(async () => {
      throw Object.assign(new Error("overloaded"), { status: 529 });
    });
    await expect(
      composeWeek(INPUT, { client: { messages: { parse } }, householdId: "h" }),
    ).rejects.toMatchObject({ code: "model_failed" });
  });

  it("refuses to compose more dinners than there are candidates", async () => {
    const { client, parse } = fakeClient(goodWeek());
    await expect(
      composeWeek({ ...INPUT, candidates: CANDIDATES.slice(0, 3) }, { client, householdId: "h" }),
    ).rejects.toMatchObject({ code: "invalid_output" });
    expect(parse).not.toHaveBeenCalled();
  });
});

describe("fallbackWeek", () => {
  it("fills every date with distinct recipes, quickest first, with a short reason", () => {
    const week = fallbackWeek(CANDIDATES, DATES, { servings: 4, cuisines: ["thai"] });
    expect(week).toHaveLength(5);
    expect(week.map((e) => e.date)).toEqual(DATES);
    expect(new Set(week.map((e) => e.recipeId)).size).toBe(5);
    for (const e of week) {
      expect(e.why.length).toBeGreaterThan(0);
      expect(e.why.length).toBeLessThan(140);
      expect(e.servings).toBe(4);
    }
  });

  it("spreads cuisines: at most two of one while others are available", () => {
    const sameCuisine = Array.from({ length: 8 }, (_, i) =>
      candidate(i, { cuisine: i < 6 ? "italian" : "thai", score: 1 - i / 100 }),
    );
    const week = fallbackWeek(sameCuisine, DATES.slice(0, 4), { servings: 2, cuisines: [] });
    const cuisines = week.map((e) => sameCuisine.find((c) => c.id === e.recipeId)?.cuisine);
    expect(cuisines.filter((c) => c === "italian").length).toBeLessThanOrEqual(2);
  });

  it("is deterministic", () => {
    const a = fallbackWeek(CANDIDATES, DATES, { servings: 4, cuisines: [] });
    const b = fallbackWeek(CANDIDATES, DATES, { servings: 4, cuisines: [] });
    expect(a).toEqual(b);
  });

  it("clamps servings and copes with fewer candidates than dates", () => {
    const week = fallbackWeek(CANDIDATES.slice(0, 2), DATES, { servings: 99, cuisines: [] });
    expect(week).toHaveLength(2);
    expect(week[0]?.servings).toBe(24);
  });
});
