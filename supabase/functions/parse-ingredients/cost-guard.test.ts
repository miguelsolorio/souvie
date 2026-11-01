// WS15: the daily cap in front of parse-ingredients' model calls. The "lines" mode has no
// household, so a user is capped by what they spent on household-less calls (WS03 review,
// 2026-10-30). Over the cap the lines still come back, parsed by the grammar and the ontology.
import { describe, expect, it, vi } from "vitest";
import { seedOntology } from "../../../packages/ingredient-parser/evals/seed-ontology.ts";
import {
  type LlmBatchResult,
  type LlmParseClient,
  parseLinesGrouped,
} from "../../../packages/ingredient-parser/src/index.ts";
import {
  type AiRunRecord,
  createDailyCapGuard,
  toAiRunRow,
} from "../../../packages/llm/src/index.ts";
import { withCostGuard } from "./cost-guard.ts";
import { SupabaseSpendStore } from "./store.ts";

const USER = "a1111111-1111-4111-8111-111111111111";
const HOUSEHOLD = "0a000000-0000-4000-8000-00000000000a";

class CountingModel implements LlmParseClient {
  readonly model = "claude-haiku-5-5";
  readonly promptVersion = "ingredient-parse.v1";
  calls = 0;
  async parseBatch(lines: readonly string[]): Promise<LlmBatchResult> {
    this.calls++;
    return {
      byIndex: new Map(),
      usage: {
        model: this.model,
        promptVersion: this.promptVersion,
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        latencyMs: 1,
        ok: true,
        lines: lines.length,
      },
    };
  }
}

function setup(spent: { user?: number; household?: number; cap?: number | null }) {
  const rows: AiRunRecord[] = [];
  const guard = createDailyCapGuard({
    capUsd: 2,
    capFor: async () => spent.cap ?? null,
    spentTodayUsd: async () => spent.household ?? 0,
    userSpentTodayUsd: async () => spent.user ?? 0,
    sink: (record) => void rows.push(record),
  });
  return { rows, guard, model: new CountingModel() };
}

describe("withCostGuard", () => {
  it("lets a user under the cap through to the model", async () => {
    const { guard, model, rows } = setup({ user: 0.5 });
    const guarded = withCostGuard(model, guard, { householdId: null, userId: USER });
    await guarded.parseBatch(["1 cup flour"]);
    expect(model.calls).toBe(1);
    expect(rows).toHaveLength(0);
    expect(guarded.model).toBe("claude-haiku-5-5");
    expect(guarded.promptVersion).toBe("ingredient-parse.v1");
  });

  it("refuses a user over the cap before the model, and writes the row with the user", async () => {
    const { guard, model, rows } = setup({ user: 2 });
    const guarded = withCostGuard(model, guard, { householdId: null, userId: USER });
    await expect(guarded.parseBatch(["1 cup flour"])).rejects.toMatchObject({
      code: "cost_cap",
      scope: "user",
    });
    expect(model.calls).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      householdId: null,
      userId: USER,
      kind: "parse_ingredients",
      model: "claude-haiku-5-5",
      promptVersion: "ingredient-parse.v1",
      ok: false,
      error: "cost_cap",
      costUsd: 0,
    });
    expect(toAiRunRow(rows[0] as AiRunRecord)).toMatchObject({
      household_id: null,
      user_id: USER,
      error: "cost_cap",
    });
  });

  it("caps a recipe's lines by the household, using the household's own cap", async () => {
    const { guard, model, rows } = setup({ household: 0.05, cap: 0.01, user: 0 });
    const guarded = withCostGuard(model, guard, { householdId: HOUSEHOLD, userId: USER });
    await expect(guarded.parseBatch(["1 cup flour"])).rejects.toMatchObject({
      code: "cost_cap",
      scope: "household",
      capUsd: 0.01,
    });
    expect(model.calls).toBe(0);
    expect(rows[0]).toMatchObject({ householdId: HOUSEHOLD, userId: USER });
  });

  it("through the parser: an over-cap user still gets the deterministic parse, with no model call", async () => {
    const { guard, model } = setup({ user: 5 });
    const onLlmError = vi.fn();
    const results = await parseLinesGrouped(
      ["2 cups all-purpose flour", "1 tablespoon gochugaru"],
      {
        ontology: seedOntology(),
        llm: withCostGuard(model, guard, { householdId: null, userId: USER }),
        onLlmError,
      },
    );
    expect(model.calls).toBe(0);
    expect(onLlmError).toHaveBeenCalledTimes(1);
    // "gochugaru" is not in the seed ontology, so it needed the model; flour did not.
    expect(results[0]?.[0]).toMatchObject({ qty: 2, unit: "cup" });
    expect(results[0]?.[0]?.ingredientId).not.toBeNull();
    expect(results[1]?.[0]).toMatchObject({ qty: 1, unit: "tbsp", ingredientId: null });
  });
});

describe("SupabaseSpendStore", () => {
  function fakeDb(reply: { data: unknown; error: { message: string } | null }) {
    const rpc = vi.fn(async () => reply);
    const eq = vi.fn();
    const query = {
      eq: (...args: unknown[]) => {
        eq(...args);
        return query;
      },
      maybeSingle: async () => reply,
    };
    const db = { rpc, from: vi.fn(() => ({ select: () => query })) };
    return { db: db as never, rpc, eq };
  }

  it("reads a user's household-less spend through user_ai_spend_since", async () => {
    const { db, rpc } = fakeDb({ data: "0.03", error: null });
    expect(await new SupabaseSpendStore(db).userSpentSince(USER, "2026-10-31T00:00:00.000Z")).toBe(
      0.03,
    );
    expect(rpc).toHaveBeenCalledWith("user_ai_spend_since", {
      p_user_id: USER,
      p_since: "2026-10-31T00:00:00.000Z",
    });
  });

  it("reads a household's spend through household_ai_spend_since", async () => {
    const { db, rpc } = fakeDb({ data: 0.42, error: null });
    expect(
      await new SupabaseSpendStore(db).householdSpentSince(HOUSEHOLD, "2026-10-31T00:00:00.000Z"),
    ).toBe(0.42);
    expect(rpc).toHaveBeenCalledWith("household_ai_spend_since", {
      p_household_id: HOUSEHOLD,
      p_since: "2026-10-31T00:00:00.000Z",
    });
  });

  it("reads the household's own cap, and throws on a database error", async () => {
    const ok = fakeDb({ data: { ai_daily_cap_usd: "0.25" }, error: null });
    expect(await new SupabaseSpendStore(ok.db).householdCapUsd(HOUSEHOLD)).toBe(0.25);
    expect(ok.eq).toHaveBeenCalledWith("id", HOUSEHOLD);
    const none = fakeDb({ data: null, error: null });
    expect(await new SupabaseSpendStore(none.db).householdCapUsd(HOUSEHOLD)).toBeNull();
    const broken = fakeDb({ data: null, error: { message: "no such column" } });
    await expect(new SupabaseSpendStore(broken.db).householdCapUsd(HOUSEHOLD)).rejects.toThrow(
      /households read failed/,
    );
    const rpcBroken = fakeDb({ data: null, error: { message: "no such function" } });
    await expect(
      new SupabaseSpendStore(rpcBroken.db).userSpentSince(USER, "2026-10-31T00:00:00.000Z"),
    ).rejects.toThrow(/user_ai_spend_since failed/);
  });
});
