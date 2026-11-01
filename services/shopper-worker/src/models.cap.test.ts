// WS15 criterion 4 in the worker: the household's own cap (households.ai_daily_cap_usd) decides,
// the call is refused before the Messages API is touched, and the refusal is an ai_runs row. On
// PGlite with the repo's migrations, the observability one included.
import type { ToolMessagesClient } from "@mp/llm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createModelSource } from "./models.ts";
import { RunStore } from "./store.ts";
import { createRunsTestDb, HOUSEHOLD, type RunsTestDb, seedHousehold } from "./testing/fixtures.ts";

let t: RunsTestDb;
let store: RunStore;

beforeAll(async () => {
  t = await createRunsTestDb({ extraMigrations: ["ws15_observability"] });
  await seedHousehold(t);
  store = new RunStore(t.runner);
}, 120_000);

afterAll(async () => {
  await t?.close();
});

beforeEach(async () => {
  await t.exec("delete from public.ai_runs");
  await t.query("update public.households set ai_daily_cap_usd = 2.00 where id = $1", [HOUSEHOLD]);
});

const request = {
  system: [{ type: "text" as const, text: "s" }],
  messages: [{ role: "user" as const, content: "hello" }],
  tools: [],
  kind: "agent_plan",
  promptVersion: "agent-system.v1",
};

function source(create: ToolMessagesClient["messages"]["create"]) {
  return createModelSource({
    toolClient: { messages: { create } },
    parseClient: { messages: { parse: vi.fn() } },
    store,
    dailyCapUsd: 2,
    log: { info() {}, warn() {}, error() {} },
  });
}

async function spend(usd: number) {
  await t.query(
    `insert into public.ai_runs (household_id, kind, model, cost_usd, ok) values ($1, 'agent_step', 'claude-sonnet-5-5', $2, true)`,
    [HOUSEHOLD, usd],
  );
}

describe("store.householdCapUsd", () => {
  it("reads the household's cap, and null for a household that does not exist", async () => {
    expect(await store.householdCapUsd(HOUSEHOLD)).toBe(2);
    await t.query("update public.households set ai_daily_cap_usd = 0.01 where id = $1", [
      HOUSEHOLD,
    ]);
    expect(await store.householdCapUsd(HOUSEHOLD)).toBe(0.01);
    expect(await store.householdCapUsd("0f000000-0000-4000-8000-00000000000f")).toBeNull();
  });
});

describe("the worker's model calls and the household's cap", () => {
  it("a household at its own $0.01 cap is refused before the Messages API, and the refusal is a row", async () => {
    await t.query("update public.households set ai_daily_cap_usd = 0.01 where id = $1", [
      HOUSEHOLD,
    ]);
    await spend(0.02);
    const create = vi.fn();
    const models = source(create);
    await expect(models.callModel(HOUSEHOLD)(request)).rejects.toMatchObject({ code: "cost_cap" });
    expect(create).not.toHaveBeenCalled();

    const rows = await t.query<{
      kind: string;
      model: string;
      prompt_version: string;
      ok: boolean;
      error: string | null;
      cost_usd: string;
      household_id: string;
    }>(`select * from public.ai_runs where error = 'cost_cap'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      household_id: HOUSEHOLD,
      kind: "agent_plan",
      model: "claude-sonnet-5-5",
      prompt_version: "agent-system.v1",
      ok: false,
      error: "cost_cap",
    });
    expect(Number(rows[0]?.cost_usd)).toBe(0);
  });

  it("the review summary is refused the same way", async () => {
    await t.query("update public.households set ai_daily_cap_usd = 0.01 where id = $1", [
      HOUSEHOLD,
    ]);
    await spend(0.02);
    const parse = vi.fn();
    const models = createModelSource({
      toolClient: { messages: { create: vi.fn() } },
      parseClient: { messages: { parse } },
      store,
      dailyCapUsd: 2,
      log: { info() {}, warn() {}, error() {} },
    });
    await expect(
      models.summarize(HOUSEHOLD)({
        storeName: "Mock QFC",
        itemCount: 12,
        matchedCount: 11,
        subtotalUsd: 42,
        needsReview: [],
        runNotes: [],
      }),
    ).rejects.toMatchObject({ code: "cost_cap" });
    expect(parse).not.toHaveBeenCalled();
    const rows = await t.query<{ kind: string }>(
      `select kind from public.ai_runs where error = 'cost_cap'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("agent_step");
  });

  it("goes past AI_DAILY_CAP_USD when the household's own cap is higher", async () => {
    await t.query("update public.households set ai_daily_cap_usd = 20 where id = $1", [HOUSEHOLD]);
    await spend(5);
    const create = vi.fn(async () => ({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    }));
    const result = await source(create as never).callModel(HOUSEHOLD)(request);
    expect(result.stopReason).toBe("end_turn");
    expect(create).toHaveBeenCalledTimes(1);
    const refused = await t.query(`select 1 from public.ai_runs where error = 'cost_cap'`);
    expect(refused).toEqual([]);
  });

  it("falls back to AI_DAILY_CAP_USD with a warning when the column cannot be read", async () => {
    const warn = vi.fn();
    const broken = Object.create(store) as RunStore;
    broken.householdCapUsd = async () => {
      throw new Error("column does not exist");
    };
    const models = createModelSource({
      toolClient: { messages: { create: vi.fn() } },
      parseClient: { messages: { parse: vi.fn() } },
      store: broken,
      dailyCapUsd: 2,
      log: { info() {}, warn, error() {} },
    });
    await spend(3);
    await expect(models.callModel(HOUSEHOLD)(request)).rejects.toMatchObject({ code: "cost_cap" });
    expect(warn).toHaveBeenCalledWith("household cap lookup failed: column does not exist");
  });
});
