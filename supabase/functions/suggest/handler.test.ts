// The suggest function end to end on PGlite (see testing/db.ts for what that stands in for), with a
// fake model, a fake Voyage endpoint, and a fake sign-in. Covers WS06 criteria 6, 7, 9, and 12 on the
// function side: the draft has the right shape, every call is logged, a housemate who is not the
// owner gets the same plan, and the hard filters hold.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALLERGENS,
  CALIBRATION_CARD_COUNT,
  SuggestCalibrationResponse,
  SuggestPlanResponse,
  SuggestSwapResponse,
} from "../../../packages/core/src/index.ts";
import type { MessagesClient } from "../../../packages/llm/src/index.ts";
import { addDays, isMonday, pickDinnerDates, weekDates } from "./compose.ts";
import { CHANGED_WHY, EMBED_BATCH, handleSuggest, type Runtime } from "./handler.ts";
import {
  FIXTURE_HOUSEHOLD,
  FIXTURE_USER,
  type LoadedCorpus,
  loadCorpus,
  OTHER_HOUSEHOLD,
  OTHER_USER,
} from "./testing/corpus.ts";
import {
  createTestDb,
  insertHousehold,
  insertIngredients,
  insertRecipe,
  type TestDb,
} from "./testing/db.ts";

const WEEK = "2026-11-02"; // a Monday, the example in the brief
const NOW = new Date("2026-10-30T18:00:00Z");
const HOUSEMATE = "c3333333-3333-4333-8333-333333333333";
const LONELY_USER = "d4444444-4444-4444-8444-444444444444";
const LONELY_HOUSEHOLD = "0d000000-0000-4000-8000-00000000000d";

let t: TestDb;
let corpus: LoadedCorpus;

const TOKENS: Record<string, string> = {
  "Bearer fixture": FIXTURE_USER,
  "Bearer other": OTHER_USER,
  "Bearer housemate": HOUSEMATE,
  "Bearer lonely": LONELY_USER,
};

/** A model that fills whatever dates and candidates the prompt shows it. */
function fakeModel(options: { badFirst?: number; summary?: string } = {}) {
  let sonnetCalls = 0;
  const parse = vi.fn(async (params: Record<string, unknown>) => {
    const content = String((params.messages as { content: string }[])[0]?.content);
    if (params.model === "claude-haiku-5-5") {
      return {
        parsed_output: {
          summary: options.summary ?? "Likes quick, bright dinners with chicken and beans.",
        },
        stop_reason: "end_turn",
        usage: { input_tokens: 300, output_tokens: 60 },
      };
    }
    sonnetCalls += 1;
    const dates = /Dates to fill, one dinner each: (.+)/.exec(content)?.[1]?.split(", ") ?? [];
    const count = Number(/<candidates count="(\d+)">/.exec(content)?.[1] ?? 0);
    const bad = sonnetCalls <= (options.badFirst ?? 0);
    return {
      parsed_output: {
        entries: dates.map((date, i) => ({
          recipeIndex: bad && i === 0 ? count + 5 : i,
          date,
          servings: 4,
          why: `Fits ${date} because it is quick and uses what you already have.`,
        })),
        notes: "Black beans and cilantro carry over.",
      },
      stop_reason: "end_turn",
      usage: { input_tokens: 2500, output_tokens: 400 },
    };
  });
  const client: MessagesClient = { messages: { parse } };
  return { client, parse, sonnetCalls: () => sonnetCalls };
}

/** A Voyage endpoint that returns a stable 1024 dimension vector for each text. */
function fakeVoyage() {
  const calls: string[][] = [];
  const fn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const input = JSON.parse(String(init?.body)).input as string[];
    calls.push(input);
    return Response.json({
      data: input.map((text, index) => {
        let seed = 7;
        for (const ch of text) seed = (seed * 31 + ch.charCodeAt(0)) % 100003;
        return {
          index,
          embedding: Array.from({ length: 1024 }, (_, i) => Math.sin(seed + i) / 2),
        };
      }),
      usage: { total_tokens: input.length * 10 },
    });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

function runtimeWith(overrides: Partial<Runtime> = {}): Runtime {
  return {
    authenticate: async (header) => {
      const userId = TOKENS[header];
      return userId ? { userId } : null;
    },
    sql: t.runner,
    now: () => NOW,
    signImagePaths: async () => new Map(),
    dailyCapUsd: 2,
    ...overrides,
  };
}

function post(body: unknown, token = "Bearer fixture", runtime: Runtime = runtimeWith()) {
  const request = new Request("http://localhost/functions/v1/suggest", {
    method: "POST",
    headers: { authorization: token, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return handleSuggest(request, runtime);
}

async function setPreferences(userId: string, preferences: Record<string, unknown>) {
  await t.query(
    "update public.profiles set preferences = $1::jsonb, onboarding_step = 7 where user_id = $2",
    [JSON.stringify(preferences), userId],
  );
}

async function planRows() {
  return t.query<{
    date: string;
    recipe_id: string;
    status: string;
    why: string;
    notes: string | null;
    servings: number;
  }>(
    `select e.date::text as date, e.recipe_id, e.status::text as status, e.why, e.notes, e.servings::float8 as servings
       from public.meal_plan_entries e join public.meal_plans p on p.id = e.plan_id
      where p.household_id = $1 order by e.date`,
    [FIXTURE_HOUSEHOLD],
  );
}

const SHELLFISH_HOUSE = {
  allergies: ["shellfish"],
  diets: [],
  dislikes: [],
  cuisines: ["mexican"],
  weeknight_minutes: 60,
  dinners_per_week: 5,
  portions: 3,
  skill: "comfortable",
  leftovers: "ok",
};

beforeAll(async () => {
  t = await createTestDb({ observability: true });
  corpus = await loadCorpus(t);
  await insertHousehold(t, {
    userId: LONELY_USER,
    householdId: LONELY_HOUSEHOLD,
    name: "Empty House",
  });
}, 60_000);

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await t.exec(
    "delete from public.meal_plan_entries; delete from public.meal_plans; delete from public.ai_runs; delete from public.recipe_feedback;",
  );
  await t.exec(
    "update public.recipes set embedding = null; update public.profiles set taste_embedding = null;",
  );
  await t.query("delete from public.household_members where user_id = $1", [HOUSEMATE]);
  await t.query("delete from auth.users where id = $1", [HOUSEMATE]);
  await setPreferences(FIXTURE_USER, SHELLFISH_HOUSE);
  await setPreferences(LONELY_USER, { allergies: [], dinners_per_week: 5 });
});

describe("request checks", () => {
  it("answers OPTIONS and refuses other methods", async () => {
    const options = await handleSuggest(
      new Request("http://x/", { method: "OPTIONS" }),
      runtimeWith(),
    );
    expect(options.status).toBe(204);
    const get = await handleSuggest(new Request("http://x/", { method: "GET" }), runtimeWith());
    expect(get.status).toBe(405);
  });

  it("needs a signed-in user", async () => {
    const none = await handleSuggest(
      new Request("http://x/", { method: "POST", body: "{}" }),
      runtimeWith(),
    );
    expect(none.status).toBe(401);
    const bad = await post(
      { householdId: FIXTURE_HOUSEHOLD, weekStart: WEEK, mode: "draft" },
      "Bearer nobody",
    );
    expect(bad.status).toBe(401);
  });

  it("rejects bad JSON, bad bodies, and a week that does not start on Monday", async () => {
    expect((await post("{nope")).status).toBe(400);
    expect((await post({ mode: "draft" })).status).toBe(400);
    expect(
      (await post({ householdId: FIXTURE_HOUSEHOLD, weekStart: WEEK, mode: "dance" })).status,
    ).toBe(400);
    const sunday = await post({
      householdId: FIXTURE_HOUSEHOLD,
      weekStart: "2026-11-01",
      mode: "draft",
    });
    expect(sunday.status).toBe(400);
    expect(await sunday.json()).toMatchObject({ error: "week_not_monday" });
    const outside = await post({
      householdId: FIXTURE_HOUSEHOLD,
      weekStart: WEEK,
      mode: "replace",
      date: "2026-11-20",
    });
    expect(outside.status).toBe(400);
  });

  it("does not let a user act in a household they are not in", async () => {
    const res = await post({ householdId: OTHER_HOUSEHOLD, weekStart: WEEK, mode: "draft" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_a_member" });
    expect(
      (
        await t.query("select count(*)::int as n from public.meal_plans where household_id = $1", [
          OTHER_HOUSEHOLD,
        ])
      )[0],
    ).toEqual({ n: 0 });
  });

  it("refuses to plan for someone who never answered the allergy question", async () => {
    await setPreferences(FIXTURE_USER, { dinners_per_week: 5 });
    const res = await post({ householdId: FIXTURE_HOUSEHOLD, weekStart: WEEK, mode: "draft" });
    expect(await res.json()).toMatchObject({ ok: false, error: "allergies_not_set" });
    expect(await planRows()).toHaveLength(0);
  });
});

describe("draft (criterion 7)", () => {
  it("returns 5 entries with distinct recipes, distinct dates inside the week, and short reasons", async () => {
    const { client } = fakeModel();
    const res = await post(
      { householdId: FIXTURE_HOUSEHOLD, weekStart: WEEK, mode: "draft" },
      "Bearer fixture",
      runtimeWith({ anthropic: async () => client }),
    );
    expect(res.status).toBe(200);
    const body = SuggestPlanResponse.parse(await res.json());
    expect(body.entries).toHaveLength(5);
    expect(new Set(body.entries.map((e) => e.recipeId)).size).toBe(5);
    expect(new Set(body.entries.map((e) => e.date)).size).toBe(5);
    const week = new Set(weekDates(WEEK));
    for (const entry of body.entries) {
      expect(week.has(entry.date)).toBe(true);
      expect(entry.slot).toBe("dinner");
      expect(entry.why.length).toBeLessThan(140);
    }
    expect(body.composedBy).toBe("model");
    expect(body.notes).toBe("Black beans and cilantro carry over.");
  });

  it("writes the plan, and never a shellfish recipe (criterion 6)", async () => {
    const { client } = fakeModel();
    const res = await post(
      { householdId: FIXTURE_HOUSEHOLD, weekStart: WEEK, mode: "draft" },
      "Bearer fixture",
      runtimeWith({ anthropic: async () => client }),
    );
    const body = SuggestPlanResponse.parse(await res.json());
    const rows = await planRows();
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.status === "planned")).toBe(true);
    // The reason goes in `why`; `notes` stays empty for the person's own.
    expect(rows.every((r) => r.why.length > 0 && r.why.length < 140)).toBe(true);
    expect(rows.every((r) => r.notes === null)).toBe(true);
    for (const row of rows) {
      const recipe = corpus.byId.get(row.recipe_id);
      expect(recipe?.labels.contains).not.toContain("shellfish");
      expect(recipe?.owner).not.toBe("other");
    }
    const plans = await t.query<{ id: string; week_start: string }>(
      "select id, week_start::text from public.meal_plans where household_id = $1",
      [FIXTURE_HOUSEHOLD],
    );
    expect(plans).toEqual([{ id: body.planId, week_start: WEEK }]);
    // servings came from the model, as whole numbers
    expect(rows.every((r) => Number.isInteger(r.servings) && r.servings > 0)).toBe(true);
    // The reason fits the real column's 200 character cap with room to spare.
    expect(rows.every((r) => r.why.length <= 200)).toBe(true);
    // A draft is not something a person saved: WS04's trigger writes `saved` only for a signed-in
    // caller, and this write runs as the service role.
    expect(await t.query("select 1 from public.recipe_feedback")).toHaveLength(0);
  });

  it("returns the existing plan on a second draft without calling the model", async () => {
    const model = fakeModel();
    const runtime = runtimeWith({ anthropic: async () => model.client });
    const first = SuggestPlanResponse.parse(
      await (
        await post(
          { householdId: FIXTURE_HOUSEHOLD, weekStart: WEEK, mode: "draft" },
          "Bearer fixture",
          runtime,
        )
      ).json(),
    );
    const calls = model.parse.mock.calls.length;
    const second = SuggestPlanResponse.parse(
      await (
        await post(
          { householdId: FIXTURE_HOUSEHOLD, weekStart: WEEK, mode: "draft" },
          "Bearer fixture",
          runtime,
        )
      ).json(),
    );
    expect(second.composedBy).toBe("existing");
    expect(second.planId).toBe(first.planId);
    expect(second.entries.map((e) => e.recipeId)).toEqual(first.entries.map((e) => e.recipeId));
    expect(model.parse.mock.calls.length).toBe(calls);
    expect(await planRows()).toHaveLength(5);
  });

  it("writes one plan when two drafts arrive together", async () => {
    const model = fakeModel();
    const runtime = runtimeWith({ anthropic: async () => model.client });
    const body = { householdId: FIXTURE_HOUSEHOLD, weekStart: WEEK, mode: "draft" };
    const [a, b] = await Promise.all([
      post(body, "Bearer fixture", runtime),
      post(body, "Bearer fixture", runtime),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await planRows()).toHaveLength(5);
  });

  it("honors the dinners argument and falls back to dinners_per_week", async () => {
    const model = fakeModel();
    const runtime = runtimeWith({ anthropic: async () => model.client });
    const three = SuggestPlanResponse.parse(
      await (
        await post(
          { householdId: FIXTURE_HOUSEHOLD, weekStart: WEEK, mode: "draft", dinners: 3 },
          "Bearer fixture",
          runtime,
        )
      ).json(),
    );
    expect(three.entries.map((e) => e.date)).toEqual(pickDinnerDates(WEEK, 3));
  });

  it("lets a housemate who is not the owner draft and read the same household plan (criterion 12)", async () => {
    await insertHousemate({ allergies: [], dinners_per_week: 5 });
    const model = fakeModel();
    const runtime = runtimeWith({ anthropic: async () => model.client });
    const owner = SuggestPlanResponse.parse(
      await (
        await post(
          { householdId: FIXTURE_HOUSEHOLD, weekStart: WEEK, mode: "draft" },
          "Bearer fixture",
          runtime,
        )
      ).json(),
    );
    const mate = SuggestPlanResponse.parse(
      await (
        await post(
          { householdId: FIXTURE_HOUSEHOLD, weekStart: WEEK, mode: "draft" },
          "Bearer housemate",
          runtime,
        )
      ).json(),
    );
    expect(mate.planId).toBe(owner.planId);
    expect(mate.entries.map((e) => e.recipeId)).toEqual(owner.entries.map((e) => e.recipeId));
  });

  it("applies every member's allergies to the shared plan", async () => {
    await insertHousemate({ allergies: ["milk", "egg"], dinners_per_week: 5 });
    const model = fakeModel();
    const runtime = runtimeWith({ anthropic: async () => model.client });
    await post(
      { householdId: FIXTURE_HOUSEHOLD, weekStart: WEEK, mode: "draft", dinners: 4 },
      "Bearer fixture",
      runtime,
    );
    const rows = await planRows();
    expect(rows.length).toBe(4);
    for (const row of rows) {
      const labels = corpus.byId.get(row.recipe_id)?.labels.contains ?? [];
      expect(labels).not.toContain("milk");
      expect(labels).not.toContain("egg");
      expect(labels).not.toContain("shellfish");
    }
  });
});

describe("a member's other fields never hide their allergies (fix round)", () => {
  async function draftRows(token: string, runtime: Runtime) {
    const res = await post(
      { householdId: FIXTURE_HOUSEHOLD, weekStart: WEEK, mode: "draft", dinners: 5 },
      token,
      runtime,
    );
    expect(res.status).toBe(200);
    return planRows();
  }

  it("keeps a housemate's allergies when another of their fields is invalid", async () => {
    // The reviewer's reproduction: weeknight_minutes 0 and skill "expert" fail the schema.
    await insertHousemate({
      allergies: ["milk", "egg"],
      weeknight_minutes: 0,
      skill: "expert",
      dinners_per_week: 5,
    });
    const model = fakeModel();
    const rows = await draftRows(
      "Bearer fixture",
      runtimeWith({ anthropic: async () => model.client }),
    );
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      const labels = corpus.byId.get(row.recipe_id)?.labels.contains ?? [];
      expect(labels, corpus.byId.get(row.recipe_id)?.key).not.toContain("milk");
      expect(labels, corpus.byId.get(row.recipe_id)?.key).not.toContain("egg");
      expect(labels).not.toContain("shellfish");
    }
  });

  it("plans for a requester whose own other fields are invalid, still without their allergy", async () => {
    await setPreferences(FIXTURE_USER, {
      allergies: ["shellfish"],
      weeknight_minutes: 0,
      skill: "expert",
      dinners_per_week: 9,
    });
    const model = fakeModel();
    const rows = await draftRows(
      "Bearer fixture",
      runtimeWith({ anthropic: async () => model.client }),
    );
    // dinners_per_week 9 is dropped on its own, so the request's own `dinners: 5` decides.
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(corpus.byId.get(row.recipe_id)?.labels.contains ?? []).not.toContain("shellfish");
    }
  });
});

describe("a draft for a week that already has a plan re-checks it (fix round)", () => {
  async function firstDraft(runtime: Runtime) {
    return SuggestPlanResponse.parse(
      await (
        await post(
          { householdId: FIXTURE_HOUSEHOLD, weekStart: WEEK, mode: "draft", dinners: 5 },
          "Bearer fixture",
          runtime,
        )
      ).json(),
    );
  }

  /** An allergen that one of the planned recipes really contains, other than the household's. */
  function allergenInPlan(recipeIds: string[]): string {
    for (const id of recipeIds) {
      const found = (corpus.byId.get(id)?.labels.contains ?? []).find((a) => a !== "shellfish");
      if (found) return found;
    }
    throw new Error("no planned recipe carries an allergen to add");
  }

  it("replaces a planned dinner that a member's new allergy rules out, with no model call", async () => {
    await insertHousemate({ allergies: [], dinners_per_week: 5 });
    const model = fakeModel();
    const runtime = runtimeWith({ anthropic: async () => model.client });
    const first = await firstDraft(runtime);
    const calls = model.parse.mock.calls.length;
    const allergen = allergenInPlan(first.entries.map((e) => e.recipeId));

    // The housemate adds an allergy after the plan was drafted.
    await setPreferences(HOUSEMATE, { allergies: [allergen], dinners_per_week: 5 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await post(
        { householdId: FIXTURE_HOUSEHOLD, weekStart: WEEK, mode: "draft" },
        "Bearer housemate",
        runtime,
      );
      const second = SuggestPlanResponse.parse(await res.json());
      expect(second.composedBy).toBe("existing");
      expect(second.planId).toBe(first.planId);
      expect(second.entries).toHaveLength(5);

      // No recipe in the plan carries the new allergen (or shellfish) any more.
      for (const entry of second.entries) {
        const labels = corpus.byId.get(entry.recipeId)?.labels.contains ?? [];
        expect(labels, corpus.byId.get(entry.recipeId)?.key).not.toContain(allergen);
        expect(labels).not.toContain("shellfish");
      }
      // Entries that were fine are untouched; the ones that changed say why.
      const before = new Map(first.entries.map((e) => [e.date, e]));
      const changed = second.entries.filter((e) => e.recipeId !== before.get(e.date)?.recipeId);
      expect(changed.length).toBeGreaterThan(0);
      for (const entry of second.entries) {
        const old = before.get(entry.date);
        if (entry.recipeId === old?.recipeId) {
          expect(entry.why).toBe(old.why);
        } else {
          expect(entry.why).toBe(CHANGED_WHY);
          expect(entry.servings).toBe(old?.servings);
        }
      }
      // The database agrees, and the model was not called again.
      const rows = await planRows();
      expect(rows.map((r) => r.recipe_id).sort()).toEqual(
        second.entries.map((e) => e.recipeId).sort(),
      );
      expect(rows.filter((r) => r.why === CHANGED_WHY)).toHaveLength(changed.length);
      expect(model.parse.mock.calls.length).toBe(calls);
      // The response says how much it changed, so the app can tell the person.
      expect(second.repaired).toEqual({ replaced: changed.length, removed: 0 });
      // The replacement is logged.
      const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
      expect(logged).toMatch(/replaced \d+ and removed \d+ planned dinner/);
    } finally {
      warn.mockRestore();
    }
  });

  it("leaves a dinner that is already cooked alone, and removes one nothing can replace", async () => {
    await insertHousemate({ allergies: [], dinners_per_week: 5 });
    const model = fakeModel();
    const runtime = runtimeWith({ anthropic: async () => model.client });
    const first = await firstDraft(runtime);
    const cookedDate = first.entries[0]?.date as string;
    await t.query(
      "update public.meal_plan_entries set status = 'cooked' where date = $1::date and household_id = $2",
      [cookedDate, FIXTURE_HOUSEHOLD],
    );
    // Every allergen at once, and no other live recipe in the corpus: nothing can take a place.
    await setPreferences(HOUSEMATE, { allergies: [...ALLERGENS], dinners_per_week: 5 });
    const live = (
      await t.query<{ id: string }>("select id from public.recipes where deleted_at is null")
    ).map((row) => row.id);
    await t.query(
      "update public.recipes set deleted_at = now() where deleted_at is null and id <> all($1::uuid[])",
      [first.entries.map((e) => e.recipeId)],
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await post(
        { householdId: FIXTURE_HOUSEHOLD, weekStart: WEEK, mode: "draft" },
        "Bearer housemate",
        runtime,
      );
      expect(res.status).toBe(200);
      const body = SuggestPlanResponse.parse(await res.json());
      expect(body.repaired?.replaced).toBe(0);
      expect(body.repaired?.removed).toBeGreaterThan(0);
      const rows = await planRows();
      // The cooked dinner is history and stays; planned ones that fail are gone, not kept.
      expect(rows.some((r) => r.date === cookedDate && r.status === "cooked")).toBe(true);
      const planned = rows.filter((r) => r.status === "planned");
      for (const row of planned) {
        const labels = corpus.byId.get(row.recipe_id)?.labels.contains ?? [];
        expect(labels.filter((label) => (ALLERGENS as readonly string[]).includes(label))).toEqual(
          [],
        );
      }
      expect(planned.length).toBeLessThan(4);
      expect(planned.some((r) => r.why === CHANGED_WHY)).toBe(false);
      expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toMatch(
        /replaced 0 and removed [1-9]/,
      );
    } finally {
      warn.mockRestore();
      await t.query("update public.recipes set deleted_at = null where id = any($1::uuid[])", [
        live,
      ]);
    }
  });

  it("changes nothing when the plan still passes", async () => {
    const model = fakeModel();
    const runtime = runtimeWith({ anthropic: async () => model.client });
    const first = await firstDraft(runtime);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const second = SuggestPlanResponse.parse(
        await (
          await post(
            { householdId: FIXTURE_HOUSEHOLD, weekStart: WEEK, mode: "draft" },
            "Bearer fixture",
            runtime,
          )
        ).json(),
      );
      expect(second.entries).toEqual(first.entries);
      expect(second.repaired).toBeUndefined();
      expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).not.toMatch(/replaced/);
    } finally {
      warn.mockRestore();
    }
  });

  it("a replace with a date re-checks the dinners it keeps", async () => {
    await insertHousemate({ allergies: [], dinners_per_week: 5 });
    const model = fakeModel();
    const runtime = runtimeWith({ anthropic: async () => model.client });
    const first = await firstDraft(runtime);
    const allergen = allergenInPlan(first.entries.map((e) => e.recipeId));
    // The night to redo is one whose dinner is fine, so every violation is among the kept ones.
    const redo = first.entries.find(
      (e) => !(corpus.byId.get(e.recipeId)?.labels.contains ?? []).includes(allergen),
    );
    expect(redo, "a planned dinner without the allergen").toBeDefined();
    const redoDate = redo?.date as string;
    await setPreferences(HOUSEMATE, { allergies: [allergen], dinners_per_week: 5 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await post(
        { householdId: FIXTURE_HOUSEHOLD, weekStart: WEEK, mode: "replace", date: redoDate },
        "Bearer housemate",
        runtime,
      );
      const body = SuggestPlanResponse.parse(await res.json());
      // The response lists the night that was redone, and says the kept ones were changed.
      expect(body.entries.map((e) => e.date)).toEqual([redoDate]);
      expect(body.repaired?.replaced).toBeGreaterThan(0);
      // Every dinner left in the week passes, including the ones the replace did not touch.
      const rows = await planRows();
      expect(rows).toHaveLength(5);
      for (const row of rows) {
        const labels = corpus.byId.get(row.recipe_id)?.labels.contains ?? [];
        expect(labels, corpus.byId.get(row.recipe_id)?.key).not.toContain(allergen);
        expect(labels).not.toContain("shellfish");
      }
      expect(rows.filter((r) => r.why === CHANGED_WHY)).toHaveLength(body.repaired?.replaced ?? -1);
      expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toMatch(/replaced \d+/);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("logging (criterion 9)", () => {
  it("writes suggest.compose rows with model, tokens, and cost", async () => {
    const model = fakeModel();
    await post(
      { householdId: FIXTURE_HOUSEHOLD, weekStart: WEEK, mode: "draft" },
      "Bearer fixture",
      runtimeWith({ anthropic: async () => model.client }),
    );
    const rows = await t.query<Record<string, unknown>>(
      "select kind, model, prompt_version, input_tokens, output_tokens, cost_usd, ok, household_id from public.ai_runs order by created_at",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "suggest.compose",
      model: "claude-sonnet-5-5",
      prompt_version: "suggest-compose.v1",
      input_tokens: 2500,
      output_tokens: 400,
      ok: true,
      household_id: FIXTURE_HOUSEHOLD,
    });
    expect(Number(rows[0]?.cost_usd)).toBeGreaterThan(0);
  });

  it("records an attempt even when no model key exists, and plans from ranked candidates", async () => {
    const res = await post({ householdId: FIXTURE_HOUSEHOLD, weekStart: WEEK, mode: "draft" });
    const body = SuggestPlanResponse.parse(await res.json());
    expect(body.composedBy).toBe("fallback");
    expect(body.entries).toHaveLength(5);
    expect(new Set(body.entries.map((e) => e.recipeId)).size).toBe(5);
    const rows = await t.query<{ kind: string; ok: boolean; error: string }>(
      "select kind, ok, error from public.ai_runs",
    );
    expect(rows).toEqual([{ kind: "suggest.compose", ok: false, error: "not_configured" }]);
  });

  it("falls back after two invalid answers, logging each attempt", async () => {
    const model = fakeModel({ badFirst: 2 });
    const res = await post(
      { householdId: FIXTURE_HOUSEHOLD, weekStart: WEEK, mode: "draft" },
      "Bearer fixture",
      runtimeWith({ anthropic: async () => model.client }),
    );
    const body = SuggestPlanResponse.parse(await res.json());
    expect(body.composedBy).toBe("fallback");
    expect(model.sonnetCalls()).toBe(2);
    const rows = await t.query<{ ok: boolean }>(
      "select ok from public.ai_runs order by created_at, id",
    );
    expect(rows).toEqual([{ ok: false }, { ok: false }]);
    expect(await planRows()).toHaveLength(5);
  });

  it("retries once and succeeds when only the first answer is invalid", async () => {
    const model = fakeModel({ badFirst: 1 });
    const res = await post(
      { householdId: FIXTURE_HOUSEHOLD, weekStart: WEEK, mode: "draft" },
      "Bearer fixture",
      runtimeWith({ anthropic: async () => model.client }),
    );
    expect(SuggestPlanResponse.parse(await res.json()).composedBy).toBe("model");
    expect(model.sonnetCalls()).toBe(2);
  });

  it("stops calling models once the household is over its daily budget", async () => {
    await t.query(
      `insert into public.ai_runs (household_id, kind, model, cost_usd, ok) values ($1, 'extract_recipe', 'claude-sonnet-5-5', 5, true)`,
      [FIXTURE_HOUSEHOLD],
    );
    const model = fakeModel();
    const res = await post(
      { householdId: FIXTURE_HOUSEHOLD, weekStart: WEEK, mode: "draft" },
      "Bearer fixture",
      runtimeWith({ anthropic: async () => model.client }),
    );
    const body = SuggestPlanResponse.parse(await res.json());
    expect(body.composedBy).toBe("fallback");
    expect(model.parse).not.toHaveBeenCalled();
    const rows = await t.query<{ error: string | null }>(
      "select error from public.ai_runs where kind = 'suggest.compose'",
    );
    expect(rows).toEqual([{ error: "cost_cap" }]);
  });
});

describe("the household's own daily cap (WS15)", () => {
  // The harness applies 20261031190000_ws15_observability.sql (createTestDb's `observability`
  // option), so households.ai_daily_cap_usd is the real column for every test in this file, not
  // only these. Without it each suggest test logged "household cap lookup failed" in CI.
  afterEach(async () => {
    await t.query("update public.households set ai_daily_cap_usd = 2.00 where id = $1", [
      FIXTURE_HOUSEHOLD,
    ]);
  });

  async function spend(usd: number) {
    await t.query(
      `insert into public.ai_runs (household_id, kind, model, cost_usd, ok) values ($1, 'extract_recipe', 'claude-sonnet-5-5', $2, true)`,
      [FIXTURE_HOUSEHOLD, usd],
    );
  }

  it("stops at the household's cap when it is lower than AI_DAILY_CAP_USD", async () => {
    await t.query("update public.households set ai_daily_cap_usd = 0.01 where id = $1", [
      FIXTURE_HOUSEHOLD,
    ]);
    await spend(0.02);
    const model = fakeModel();
    const res = await post(
      { householdId: FIXTURE_HOUSEHOLD, weekStart: WEEK, mode: "draft" },
      "Bearer fixture",
      runtimeWith({ anthropic: async () => model.client }),
    );
    expect(SuggestPlanResponse.parse(await res.json()).composedBy).toBe("fallback");
    expect(model.parse).not.toHaveBeenCalled();
    const rows = await t.query<{ kind: string; ok: boolean; error: string | null }>(
      "select kind, ok, error from public.ai_runs where error = 'cost_cap'",
    );
    expect(rows).toEqual([{ kind: "suggest.compose", ok: false, error: "cost_cap" }]);
  });

  it("goes on past AI_DAILY_CAP_USD when the household's cap is higher", async () => {
    await t.query("update public.households set ai_daily_cap_usd = 20 where id = $1", [
      FIXTURE_HOUSEHOLD,
    ]);
    await spend(5);
    const model = fakeModel();
    const res = await post(
      { householdId: FIXTURE_HOUSEHOLD, weekStart: WEEK, mode: "draft" },
      "Bearer fixture",
      runtimeWith({ anthropic: async () => model.client }),
    );
    expect(SuggestPlanResponse.parse(await res.json()).composedBy).toBe("model");
    expect(model.sonnetCalls()).toBe(1);
  });

  // Skipping the guard stayed green for both embedding paths until these two (WS15 review): the
  // recipe embeddings go through `embed(..., { guard })` and the taste summary through
  // `buildTasteEmbedding(..., { guard })`, and each is a model call that costs money.
  it("makes no Voyage request for recipe embeddings once the household is over its cap", async () => {
    await spend(5);
    const voyage = fakeVoyage();
    const model = fakeModel();
    const res = await post(
      { householdId: FIXTURE_HOUSEHOLD, weekStart: WEEK, mode: "draft" },
      "Bearer fixture",
      runtimeWith({
        anthropic: async () => model.client,
        voyageKey: "pa-test",
        fetch: voyage.fetch,
      }),
    );
    expect(res.status).toBe(200);
    expect(voyage.calls).toEqual([]);
    const refused = await t.query<{ model: string; ok: boolean; error: string | null }>(
      "select model, ok, error from public.ai_runs where kind = 'suggest.embed'",
    );
    expect(refused).toEqual([{ model: "voyage-3", ok: false, error: "cost_cap" }]);
  });

  it("makes no Haiku call for the taste summary once the household is over its cap", async () => {
    // Every recipe already has an embedding, so the only model call left to guard is the summary.
    await t.exec(
      "update public.recipes set embedding = array_fill(0.01::real, array[1024])::vector",
    );
    await t.query(
      `insert into public.recipe_feedback (household_id, user_id, recipe_id, signal)
       values ($1, $2, $3, 'like')`,
      [FIXTURE_HOUSEHOLD, FIXTURE_USER, corpus.ids.get("black-bean-tacos")],
    );
    await spend(5);
    const voyage = fakeVoyage();
    const model = fakeModel();
    const res = await post(
      { householdId: FIXTURE_HOUSEHOLD, weekStart: WEEK, mode: "draft" },
      "Bearer fixture",
      runtimeWith({
        anthropic: async () => model.client,
        voyageKey: "pa-test",
        fetch: voyage.fetch,
      }),
    );
    expect(res.status).toBe(200);
    const haikuCalls = model.parse.mock.calls.filter(
      ([params]) => (params as { model?: string }).model === "claude-haiku-5-5",
    );
    expect(haikuCalls).toEqual([]);
    expect(voyage.calls).toEqual([]);
    const refused = await t.query<{ model: string; ok: boolean; error: string | null }>(
      "select model, ok, error from public.ai_runs where kind = 'suggest.embed'",
    );
    // The summary is refused, and so is the plain-text embedding the taste profile falls back to.
    expect(refused.every((row) => !row.ok)).toBe(true);
    expect(refused.map((row) => `${row.model}:${row.error}`).sort()).toEqual([
      "claude-haiku-5-5:cost_cap",
      "voyage-3:cost_cap",
    ]);
  });
});

describe("embeddings", () => {
  it("embeds the household's recipes and the taste profile, logs suggest.embed, and ranks with them", async () => {
    const voyage = fakeVoyage();
    const model = fakeModel();
    await t.query(
      `insert into public.recipe_feedback (household_id, user_id, recipe_id, signal)
       values ($1, $2, $3, 'like'), ($1, $2, $4, 'dislike')`,
      [
        FIXTURE_HOUSEHOLD,
        FIXTURE_USER,
        corpus.ids.get("black-bean-tacos"),
        corpus.ids.get("beef-broccoli"),
      ],
    );
    const res = await post(
      { householdId: FIXTURE_HOUSEHOLD, weekStart: WEEK, mode: "draft" },
      "Bearer fixture",
      runtimeWith({
        anthropic: async () => model.client,
        voyageKey: "pa-test",
        fetch: voyage.fetch,
      }),
    );
    expect(res.status).toBe(200);

    const taste = await t.query<{ present: boolean }>(
      "select taste_embedding is not null as present from public.profiles where user_id = $1",
      [FIXTURE_USER],
    );
    expect(taste[0]?.present).toBe(true);
    const embedded = await t.query<{ n: number }>(
      "select count(*)::int as n from public.recipes where household_id = $1 and embedding is not null",
      [FIXTURE_HOUSEHOLD],
    );
    // EMBED_BATCH recipes are embedded per plan, so the household's 40-odd recipes need two.
    expect(embedded[0]?.n).toBe(EMBED_BATCH);

    const kinds = await t.query<{ kind: string; model: string }>(
      "select kind, model from public.ai_runs order by created_at, id",
    );
    expect(kinds.map((k) => k.kind)).toContain("suggest.embed");
    expect(kinds.map((k) => k.kind)).toContain("suggest.compose");
    expect(kinds.filter((k) => k.kind === "suggest.embed").map((k) => k.model)).toEqual(
      expect.arrayContaining(["voyage-3", "claude-haiku-5-5"]),
    );
    // A recipe the person skipped is still a candidate unless a filter removes it, but the
    // taste summary text sent to Voyage mentions what they liked.
    const queries = voyage.calls.flat().join("\n");
    expect(queries).toContain("Black bean tacos");
  });

  it("plans without embeddings when the Voyage key is missing", async () => {
    const model = fakeModel();
    const res = await post(
      { householdId: FIXTURE_HOUSEHOLD, weekStart: WEEK, mode: "draft" },
      "Bearer fixture",
      runtimeWith({ anthropic: async () => model.client }),
    );
    expect(SuggestPlanResponse.parse(await res.json()).entries).toHaveLength(5);
    const taste = await t.query<{ present: boolean }>(
      "select taste_embedding is not null as present from public.profiles where user_id = $1",
      [FIXTURE_USER],
    );
    expect(taste[0]?.present).toBe(false);
  });

  it("still plans when Voyage is down", async () => {
    const model = fakeModel();
    const failing = vi.fn(
      async () => new Response("down", { status: 503 }),
    ) as unknown as typeof fetch;
    const res = await post(
      { householdId: FIXTURE_HOUSEHOLD, weekStart: WEEK, mode: "draft" },
      "Bearer fixture",
      runtimeWith({ anthropic: async () => model.client, voyageKey: "pa-test", fetch: failing }),
    );
    expect(SuggestPlanResponse.parse(await res.json()).entries).toHaveLength(5);
  });

  it("backfills missing recipe embeddings in batches", async () => {
    const voyage = fakeVoyage();
    const runtime = runtimeWith({ voyageKey: "pa-test", fetch: voyage.fetch });
    const body = { householdId: FIXTURE_HOUSEHOLD, weekStart: WEEK, mode: "backfill" };
    const first = (await (await post(body, "Bearer fixture", runtime)).json()) as {
      ok: boolean;
      embedded: number;
      remaining: number;
    };
    expect(first.ok).toBe(true);
    expect(first.embedded).toBeGreaterThan(0);
    expect(first.embedded + first.remaining).toBeGreaterThan(0);
    // The household's own recipes and the starter catalog are filled; the count adds up.
    const row = await t.query<{ n: number }>(
      "select count(*)::int as n from public.recipes where (household_id = $1 or visibility = 'catalog') and embedding is not null",
      [FIXTURE_HOUSEHOLD],
    );
    expect(row[0]?.n).toBe(first.embedded);
    const catalog = await t.query<{ n: number }>(
      "select count(*)::int as n from public.recipes where visibility = 'catalog' and embedding is not null",
    );
    expect(catalog[0]?.n).toBeGreaterThan(0);
    // Other households' recipes are never touched.
    const other = await t.query<{ n: number }>(
      "select count(*)::int as n from public.recipes where household_id = $1 and embedding is not null",
      [OTHER_HOUSEHOLD],
    );
    expect(other[0]?.n).toBe(0);
    const second = (await (await post(body, "Bearer fixture", runtime)).json()) as {
      remaining: number;
    };
    expect(second.remaining).toBe(0);
  });

  it("says so when backfill has no key", async () => {
    const res = await post({ householdId: FIXTURE_HOUSEHOLD, weekStart: WEEK, mode: "backfill" });
    expect(await res.json()).toMatchObject({ ok: false, error: "embedding_unavailable" });
  });
});

describe("replace", () => {
  async function draft(runtime: Runtime) {
    return SuggestPlanResponse.parse(
      await (
        await post(
          { householdId: FIXTURE_HOUSEHOLD, weekStart: WEEK, mode: "draft" },
          "Bearer fixture",
          runtime,
        )
      ).json(),
    );
  }

  it("replaces still-planned dinners and leaves cooked ones alone", async () => {
    const model = fakeModel();
    const runtime = runtimeWith({ anthropic: async () => model.client });
    const first = await draft(runtime);
    await t.query(
      "update public.meal_plan_entries set status = 'cooked' where date = $1::date and household_id = $2",
      [first.entries[0]?.date, FIXTURE_HOUSEHOLD],
    );
    const res = await post(
      { householdId: FIXTURE_HOUSEHOLD, weekStart: WEEK, mode: "replace" },
      "Bearer fixture",
      runtime,
    );
    const body = SuggestPlanResponse.parse(await res.json());
    expect(body.planId).toBe(first.planId);
    const rows = await planRows();
    const cooked = rows.filter((r) => r.status === "cooked");
    expect(cooked).toHaveLength(1);
    expect(cooked[0]?.recipe_id).toBe(first.entries[0]?.recipeId);
    // The cooked night is not offered again: four new dinners plus the cooked one.
    expect(body.entries).toHaveLength(4);
    expect(body.entries.map((e) => e.date)).not.toContain(first.entries[0]?.date);
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((r) => r.recipe_id)).size).toBe(5);
  });

  it("replaces one night when given a date, with a different recipe", async () => {
    const model = fakeModel();
    const runtime = runtimeWith({ anthropic: async () => model.client });
    const first = await draft(runtime);
    const target = first.entries[2];
    const res = await post(
      { householdId: FIXTURE_HOUSEHOLD, weekStart: WEEK, mode: "replace", date: target?.date },
      "Bearer fixture",
      runtime,
    );
    const body = SuggestPlanResponse.parse(await res.json());
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]?.date).toBe(target?.date);
    expect(body.entries[0]?.recipeId).not.toBe(target?.recipeId);
    const rows = await planRows();
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((r) => r.recipe_id)).size).toBe(5);
    for (const other of first.entries.filter((e) => e.date !== target?.date)) {
      expect(rows.find((r) => r.date === other.date)?.recipe_id).toBe(other.recipeId);
    }
  });

  it("will not replace a night that was already cooked", async () => {
    const model = fakeModel();
    const runtime = runtimeWith({ anthropic: async () => model.client });
    const first = await draft(runtime);
    await t.query("update public.meal_plan_entries set status = 'skipped' where date = $1::date", [
      first.entries[1]?.date,
    ]);
    const res = await post(
      {
        householdId: FIXTURE_HOUSEHOLD,
        weekStart: WEEK,
        mode: "replace",
        date: first.entries[1]?.date,
      },
      "Bearer fixture",
      runtime,
    );
    expect(res.status).toBe(400);
  });
});

describe("calibration (criterion 6)", () => {
  it("returns twelve recipes that pass the hard filters and writes no plan", async () => {
    const res = await post({
      householdId: FIXTURE_HOUSEHOLD,
      weekStart: WEEK,
      mode: "calibration",
    });
    expect(res.status).toBe(200);
    const body = SuggestCalibrationResponse.parse(await res.json());
    expect(body.recipeIds).toHaveLength(CALIBRATION_CARD_COUNT);
    expect(body.cards.map((c) => c.recipeId)).toEqual(body.recipeIds);
    expect(new Set(body.recipeIds).size).toBe(CALIBRATION_CARD_COUNT);
    for (const id of body.recipeIds) {
      const recipe = corpus.byId.get(id);
      expect(recipe?.labels.contains).not.toContain("shellfish");
      expect(recipe?.owner).not.toBe("other");
      expect(recipe?.deleted).toBe(false);
    }
    expect(await planRows()).toHaveLength(0);
    const plans = await t.query<{ n: number }>("select count(*)::int as n from public.meal_plans");
    expect(plans[0]?.n).toBe(0);
  });

  it("does not show a recipe the person already answered", async () => {
    const first = SuggestCalibrationResponse.parse(
      await (
        await post({ householdId: FIXTURE_HOUSEHOLD, weekStart: WEEK, mode: "calibration" })
      ).json(),
    );
    const answered = first.recipeIds.slice(0, 4);
    for (const id of answered) {
      await t.query(
        "insert into public.recipe_feedback (household_id, user_id, recipe_id, signal) values ($1, $2, $3, 'like')",
        [FIXTURE_HOUSEHOLD, FIXTURE_USER, id],
      );
    }
    const second = SuggestCalibrationResponse.parse(
      await (
        await post({ householdId: FIXTURE_HOUSEHOLD, weekStart: WEEK, mode: "calibration" })
      ).json(),
    );
    for (const id of answered) expect(second.recipeIds).not.toContain(id);
  });

  it("spreads the cards over cuisines", async () => {
    const body = SuggestCalibrationResponse.parse(
      await (
        await post({ householdId: FIXTURE_HOUSEHOLD, weekStart: WEEK, mode: "calibration" })
      ).json(),
    );
    const cuisines = new Set(body.cards.map((c) => c.cuisine));
    expect(cuisines.size).toBeGreaterThanOrEqual(5);
  });

  it("signs images in the household folder and nowhere else", async () => {
    await t.query("update public.recipes set image_url = $1 where id = $2", [
      `${FIXTURE_HOUSEHOLD}/photo.jpg`,
      corpus.ids.get("black-bean-tacos"),
    ]);
    await t.query("update public.recipes set image_url = $1 where id = $2", [
      `${OTHER_HOUSEHOLD}/steal.jpg`,
      corpus.ids.get("gazpacho"),
    ]);
    const signImagePaths = vi.fn(
      async (paths: readonly string[]) =>
        new Map(paths.map((p) => [p, `https://signed.example/${p}`])),
    );
    const body = SuggestCalibrationResponse.parse(
      await (
        await post(
          { householdId: FIXTURE_HOUSEHOLD, weekStart: WEEK, mode: "calibration" },
          "Bearer fixture",
          runtimeWith({ signImagePaths }),
        )
      ).json(),
    );
    for (const call of signImagePaths.mock.calls) {
      for (const path of call[0]) expect(path.startsWith(`${FIXTURE_HOUSEHOLD}/`)).toBe(true);
    }
    const tacos = body.cards.find((c) => c.recipeId === corpus.ids.get("black-bean-tacos"));
    if (tacos) expect(tacos.imageUrl).toBe(`https://signed.example/${FIXTURE_HOUSEHOLD}/photo.jpg`);
    const gazpacho = body.cards.find((c) => c.recipeId === corpus.ids.get("gazpacho"));
    if (gazpacho) expect(gazpacho.imageUrl).toBeNull();
  });
});

describe("swap", () => {
  const swapBody = (extra: Record<string, unknown> = {}) => ({
    householdId: FIXTURE_HOUSEHOLD,
    weekStart: WEEK,
    mode: "swap",
    date: "2026-11-04",
    slot: "dinner",
    excludeRecipeIds: [] as string[],
    ...extra,
  });

  async function swap(extra: Record<string, unknown> = {}, runtime: Runtime = runtimeWith()) {
    const res = await post(swapBody(extra), "Bearer fixture", runtime);
    return { res, body: (await res.json()) as Record<string, unknown> };
  }

  async function rowCounts() {
    const rows = await t.query<Record<string, number>>(
      `select (select count(*) from public.meal_plans)::int as plans,
              (select count(*) from public.meal_plan_entries)::int as entries,
              (select count(*) from public.recipe_feedback)::int as feedback,
              (select count(*) from public.ai_runs)::int as runs,
              (select count(*) from public.recipes where embedding is not null)::int as embedded,
              (select count(*) from public.profiles where taste_embedding is not null)::int as tastes`,
    );
    return rows[0];
  }

  it("returns exactly one entry for the date and slot, and writes nothing", async () => {
    const before = await rowCounts();
    const { res, body } = await swap();
    expect(res.status).toBe(200);
    expect(SuggestSwapResponse.parse(body).entries).toHaveLength(1);
    const entry = (body.entries as Record<string, unknown>[])[0];
    expect(entry).toMatchObject({ date: "2026-11-04", slot: "dinner" });
    expect(corpus.byId.has(String(entry?.recipeId))).toBe(true);
    expect(Number.isInteger(entry?.servings)).toBe(true);
    expect(String(entry?.why).length).toBeGreaterThan(0);
    expect(String(entry?.why).length).toBeLessThan(140);
    // No plan row, no entry, no feedback, no log, no embedding written anywhere.
    expect(await rowCounts()).toEqual(before);
    // With no plan for the week, there is no plan id to return.
    expect(body.planId).toBeUndefined();
  });

  it("never returns a recipe from the exclude list, one swap after another", async () => {
    const seen: string[] = [];
    for (let i = 0; i < 12; i++) {
      const { body } = await swap({ excludeRecipeIds: seen });
      const entry = (body.entries as { recipeId: string }[])[0];
      expect(entry).toBeDefined();
      expect(seen).not.toContain(entry?.recipeId);
      seen.push(String(entry?.recipeId));
    }
    expect(new Set(seen).size).toBe(12);
  });

  it("leaves out the recipes already on that week's plan and returns the plan id", async () => {
    const model = fakeModel();
    const runtime = runtimeWith({ anthropic: async () => model.client });
    const plan = SuggestPlanResponse.parse(
      await (
        await post(
          { householdId: FIXTURE_HOUSEHOLD, weekStart: WEEK, mode: "draft" },
          "Bearer fixture",
          runtime,
        )
      ).json(),
    );
    const planned = new Set(plan.entries.map((e) => e.recipeId));
    const before = await rowCounts();
    for (let i = 0; i < 5; i++) {
      const { body } = await swap({}, runtime);
      const entry = (body.entries as { recipeId: string }[])[0];
      expect(planned.has(String(entry?.recipeId))).toBe(false);
      expect(body.planId).toBe(plan.planId);
    }
    expect(await rowCounts()).toEqual(before);
  });

  it("applies the same hard filters as a draft", async () => {
    const seen: string[] = [];
    for (let i = 0; i < 15; i++) {
      const { body } = await swap({ excludeRecipeIds: seen });
      const entry = (body.entries as { recipeId: string }[])[0];
      const recipe = corpus.byId.get(String(entry?.recipeId));
      expect(recipe?.labels.contains).not.toContain("shellfish");
      expect(recipe?.owner).not.toBe("other");
      expect(recipe?.deleted).toBe(false);
      seen.push(String(entry?.recipeId));
    }
  });

  it("applies every housemate's allergies too", async () => {
    await insertHousemate({ allergies: ["milk", "egg"], dinners_per_week: 5 });
    const seen: string[] = [];
    for (let i = 0; i < 10; i++) {
      const { body } = await swap({ excludeRecipeIds: seen });
      const entry = (body.entries as { recipeId: string }[])[0];
      const labels = corpus.byId.get(String(entry?.recipeId))?.labels.contains ?? [];
      expect(labels).not.toContain("milk");
      expect(labels).not.toContain("egg");
      seen.push(String(entry?.recipeId));
    }
  });

  it("calls no model", async () => {
    const model = fakeModel();
    await swap({}, runtimeWith({ anthropic: async () => model.client }));
    expect(model.parse).not.toHaveBeenCalled();
  });

  it("says there is nothing to suggest when everything is excluded", async () => {
    const every = [...corpus.ids.values()];
    expect(every.length).toBeLessThanOrEqual(200);
    const { res, body } = await swap({ excludeRecipeIds: every });
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: false, error: "no_candidates" });
  });

  it("lets a snack swap return a recipe a dinner swap would never show", async () => {
    // Exclude everything except the dessert and the smoothie, which are tagged as not dinners.
    const keep = new Set([corpus.ids.get("chocolate-cake"), corpus.ids.get("berry-smoothie")]);
    const exclude = [...corpus.ids.values()].filter((id) => !keep.has(id));
    const dinner = await swap({ excludeRecipeIds: exclude, slot: "dinner" });
    expect(dinner.body).toMatchObject({ ok: false, error: "no_candidates" });
    const snack = await swap({ excludeRecipeIds: exclude, slot: "snack" });
    const entry = (snack.body.entries as { recipeId: string; slot: string }[])[0];
    expect(keep.has(entry?.recipeId)).toBe(true);
    expect(entry?.slot).toBe("snack");
  });

  it("echoes the slot and date it was asked for", async () => {
    const { body } = await swap({ slot: "lunch", date: "2026-11-08" });
    expect((body.entries as Record<string, unknown>[])[0]).toMatchObject({
      slot: "lunch",
      date: "2026-11-08",
    });
  });

  it("needs a date, a slot, a Monday, and a date inside the week", async () => {
    expect((await post({ ...swapBody(), date: undefined })).status).toBe(400);
    expect((await post({ ...swapBody(), slot: undefined })).status).toBe(400);
    expect((await post({ ...swapBody(), slot: "brunch" })).status).toBe(400);
    expect((await post({ ...swapBody(), weekStart: "2026-11-03" })).status).toBe(400);
    expect((await post({ ...swapBody(), date: "2026-11-20" })).status).toBe(400);
  });

  it("accepts up to 200 recipe ids to avoid and refuses more", async () => {
    const ids = Array.from(
      { length: 200 },
      (_, i) => `c77e0000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    expect((await post(swapBody({ excludeRecipeIds: ids }))).status).toBe(200);
    expect((await post(swapBody({ excludeRecipeIds: [...ids, ids[0]] }))).status).toBe(400);
  });

  it("is for members only and needs the allergy answer", async () => {
    const outsider = await post(swapBody({ householdId: OTHER_HOUSEHOLD }));
    expect(outsider.status).toBe(403);
    await setPreferences(FIXTURE_USER, { dinners_per_week: 5 });
    const { body } = await swap();
    expect(body).toMatchObject({ ok: false, error: "allergies_not_set" });
  });
});

describe("thin libraries", () => {
  // The catalog is visible to every household. These tests take it away for their own length.
  beforeEach(async () => {
    await t.exec("update public.recipes set deleted_at = now() where household_id is null");
  });
  afterEach(async () => {
    await t.exec("update public.recipes set deleted_at = null where household_id is null");
  });

  it("says there is nothing to plan from when no recipe fits", async () => {
    const res = await post(
      { householdId: LONELY_HOUSEHOLD, weekStart: WEEK, mode: "draft" },
      "Bearer lonely",
    );
    expect(await res.json()).toMatchObject({ ok: false, error: "no_candidates" });
    const cal = await post(
      { householdId: LONELY_HOUSEHOLD, weekStart: WEEK, mode: "calibration" },
      "Bearer lonely",
    );
    expect(await cal.json()).toMatchObject({ ok: true, recipeIds: [], cards: [] });
  });

  it("plans as many dinners as there are recipes and says how many are missing", async () => {
    const ids = await insertIngredients(t, [{ name: "lonely rice", category: "pantry" }]);
    for (const title of ["Lonely one", "Lonely two", "Lonely three"]) {
      await insertRecipe(
        t,
        {
          title,
          householdId: LONELY_HOUSEHOLD,
          cuisine: null,
          tags: [],
          prepMin: 10,
          cookMin: 10,
          lines: [{ rawText: "1 cup lonely rice", name: "lonely rice" }],
        },
        ids,
      );
    }
    const res = await post(
      { householdId: LONELY_HOUSEHOLD, weekStart: WEEK, mode: "draft" },
      "Bearer lonely",
    );
    const body = SuggestPlanResponse.parse(await res.json());
    expect(body.entries).toHaveLength(3);
    expect(body.shortBy).toBe(2);
    await t.query("delete from public.meal_plan_entries where household_id = $1", [
      LONELY_HOUSEHOLD,
    ]);
    await t.query("delete from public.meal_plans where household_id = $1", [LONELY_HOUSEHOLD]);
    await t.query("delete from public.recipes where household_id = $1", [LONELY_HOUSEHOLD]);
  });
});

describe("date helpers", () => {
  it("knows Mondays and builds weeks", () => {
    expect(isMonday("2026-11-02")).toBe(true);
    expect(isMonday("2026-11-03")).toBe(false);
    expect(weekDates("2026-11-02")).toEqual([
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
      "2026-11-06",
      "2026-11-07",
      "2026-11-08",
    ]);
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
  });

  it("picks the first free nights, Monday first", () => {
    expect(pickDinnerDates("2026-11-02", 5)).toEqual([
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
      "2026-11-06",
    ]);
    expect(pickDinnerDates("2026-11-02", 3, new Set(["2026-11-03"]))).toEqual([
      "2026-11-02",
      "2026-11-04",
      "2026-11-05",
    ]);
    expect(pickDinnerDates("2026-11-02", 9)).toHaveLength(7);
    expect(pickDinnerDates("2026-11-02", 0)).toEqual([]);
  });
});

async function insertHousemate(preferences: Record<string, unknown>) {
  await t.query(
    "insert into auth.users (id, email) values ($1, 'mate@example.test') on conflict (id) do nothing",
    [HOUSEMATE],
  );
  await t.query(
    "insert into public.household_members (household_id, user_id, role) values ($1, $2, 'member')",
    [FIXTURE_HOUSEHOLD, HOUSEMATE],
  );
  await setPreferences(HOUSEMATE, preferences);
}
