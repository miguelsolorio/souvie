import { type MealPlan, MealPlanEntryInput, weekDates, weekStartFor } from "@mp/core";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DeleteEntryInput, deleteEntryOptions } from "./hooks/useDeleteEntry";
import { currentThumb, favoriteIds, setThumb, setThumbOptions } from "./hooks/useRecipeFeedback";
import { type UpsertEntryInput, upsertEntryOptions } from "./hooks/useUpsertEntry";
import { newId, setIdGenerator } from "./ids";
import {
  distinctRecipeIds,
  ensureMealPlan,
  fetchMealPlan,
  fetchMealPlanEntries,
  fetchRecentRecipeIds,
  insertEntry,
  invalidateMealPlan,
  inversePatch,
  mealPlanEntriesKey,
  mealPlanKey,
  mealPlanRootKey,
  type PlanEntry,
  PlanError,
  patchEntry,
  planErrorMessage,
  planRetryDelay,
  planWritesPending,
  removeEntry,
  shouldRetryPlanWrite,
  toPlanError,
  withEntry,
  withoutEntry,
  withPatch,
} from "./planning";
import { fakeClient, OFFLINE } from "./testing/fakeClient";

const HOUSEHOLD = "0a000000-0000-4000-8000-00000000000a";
const OTHER_HOUSEHOLD = "0b000000-0000-4000-8000-00000000000b";
const USER = "a1111111-1111-4111-8111-111111111111";
const WEEK = "2026-11-02";
const TUESDAY = "2026-11-03";
const PLAN = "ca000000-0000-4000-8000-0000000000a1";
const REMOTE_PLAN = "ca000000-0000-4000-8000-0000000000ff";
const RECIPE = "aa000000-0000-4000-8000-000000000001";
const RECIPE_2 = "aa000000-0000-4000-8000-000000000002";
const ENTRY = "ea000000-0000-4000-8000-0000000000a1";
const ENTRY_2 = "ea000000-0000-4000-8000-0000000000a2";

const lemonChicken = {
  id: RECIPE,
  title: "Lemon chicken",
  image_url: null,
  servings: 4,
  prep_min: 10,
  cook_min: 30,
  deleted_at: null,
};
const greenCurry = { ...lemonChicken, id: RECIPE_2, title: "Green curry" };

function newQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } },
  });
}

function world() {
  const { client, server, channels } = fakeClient();
  server.tables.recipes?.push({ ...lemonChicken }, { ...greenCurry });
  const queryClient = newQueryClient();
  return { client, server, channels, queryClient };
}

const addInput = (
  over: Partial<Extract<UpsertEntryInput, { mode: "add" }>> = {},
): UpsertEntryInput => ({
  mode: "add",
  id: ENTRY,
  householdId: HOUSEHOLD,
  planId: PLAN,
  planIsNew: true,
  entry: { date: TUESDAY, slot: "dinner", recipe_id: RECIPE, servings: 4 },
  recipe: lemonChicken,
  ...over,
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const until = async (check: () => boolean, label: string) => {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${label}`);
};

function seedEntry(queryClient: QueryClient, over: Partial<PlanEntry> = {}): PlanEntry {
  const entry: PlanEntry = {
    id: ENTRY,
    plan_id: PLAN,
    household_id: HOUSEHOLD,
    date: TUESDAY,
    slot: "dinner",
    recipe_id: RECIPE,
    servings: 4,
    status: "planned",
    notes: null,
    position: 0,
    created_at: "2026-10-30T12:00:00.000Z",
    updated_at: "2026-10-30T12:00:00.000Z",
    recipe: lemonChicken,
    ...over,
  };
  const plan: MealPlan = {
    id: PLAN,
    household_id: HOUSEHOLD,
    week_start: WEEK,
    created_at: entry.created_at,
    updated_at: entry.created_at,
  };
  queryClient.setQueryData(mealPlanKey(HOUSEHOLD, WEEK), plan);
  queryClient.setQueryData(mealPlanEntriesKey(HOUSEHOLD, PLAN), [entry]);
  return entry;
}

/** The same row on the server, as the database would hold it. */
function seedServer(server: ReturnType<typeof world>["server"], entry: PlanEntry) {
  const { recipe: _recipe, ...row } = entry;
  server.tables.meal_plans?.push({
    id: PLAN,
    household_id: HOUSEHOLD,
    week_start: WEEK,
    created_at: entry.created_at,
    updated_at: entry.created_at,
  });
  server.tables.meal_plan_entries?.push({ ...row });
}

describe("query keys", () => {
  it("put the household first, so a persisted cache never crosses households", () => {
    expect(mealPlanKey(HOUSEHOLD, WEEK)).toEqual(["meal-plan", HOUSEHOLD, WEEK]);
    expect(mealPlanKey(OTHER_HOUSEHOLD, WEEK)).not.toEqual(mealPlanKey(HOUSEHOLD, WEEK));
    expect(mealPlanEntriesKey(HOUSEHOLD, PLAN)).toEqual(["meal-plan", HOUSEHOLD, "entries", PLAN]);
    expect(mealPlanRootKey(HOUSEHOLD)).toEqual(["meal-plan", HOUSEHOLD]);
  });

  it("nest under the root key the Realtime handler invalidates", async () => {
    const queryClient = newQueryClient();
    queryClient.setQueryData(mealPlanKey(HOUSEHOLD, WEEK), null);
    queryClient.setQueryData(mealPlanEntriesKey(HOUSEHOLD, PLAN), []);
    queryClient.setQueryData(mealPlanKey(OTHER_HOUSEHOLD, WEEK), null);
    await queryClient.invalidateQueries({ queryKey: mealPlanRootKey(HOUSEHOLD) });
    const state = (key: readonly unknown[]) => queryClient.getQueryState(key)?.isInvalidated;
    expect(state(mealPlanKey(HOUSEHOLD, WEEK))).toBe(true);
    expect(state(mealPlanEntriesKey(HOUSEHOLD, PLAN))).toBe(true);
    expect(state(mealPlanKey(OTHER_HOUSEHOLD, WEEK))).toBe(false);
  });
});

describe("toPlanError", () => {
  it("recognizes a dropped connection by status 0 or by the fetch error text", () => {
    expect(toPlanError({ message: "TypeError: Failed to fetch", code: "" }, 0).code).toBe(
      "network",
    );
    expect(toPlanError({ message: "TypeError: Network request failed" }).code).toBe("network");
    expect(toPlanError({ message: "AbortError: The operation was aborted" }, 0).code).toBe(
      "network",
    );
    expect(toPlanError({ message: "upstream", code: "" }, 503).code).toBe("network");
  });

  it("maps the codes the planning migration raises", () => {
    expect(toPlanError({ message: "plan_not_found", code: "P0001" }, 400).code).toBe("not_found");
    expect(toPlanError({ message: "recipe_not_found", code: "P0001" }, 400).code).toBe("not_found");
    expect(toPlanError({ message: "date_outside_plan_week", code: "P0001" }, 400).code).toBe(
      "invalid",
    );
    expect(toPlanError({ message: "permission denied", code: "42501" }, 403).code).toBe(
      "forbidden",
    );
    expect(toPlanError({ message: "violates check", code: "23514" }, 400).code).toBe("invalid");
    expect(toPlanError({ message: "fk", code: "23503" }, 409).code).toBe("not_found");
    expect(toPlanError({ message: "dup", code: "23505" }, 409).code).toBe("conflict");
    expect(toPlanError({ message: "huh", code: "XX000" }, 400).code).toBe("unknown");
  });

  it("gives every code a sentence for the person", () => {
    for (const code of [
      "network",
      "forbidden",
      "not_found",
      "invalid",
      "conflict",
      "unknown",
    ] as const) {
      expect(planErrorMessage(new PlanError(code))).toMatch(/\.$/);
    }
    expect(planErrorMessage(new Error("boom"))).toBe("Something went wrong. Try again.");
  });

  it("retries only a dropped connection, with growing delays", () => {
    expect(shouldRetryPlanWrite(0, new PlanError("network"))).toBe(true);
    expect(shouldRetryPlanWrite(5, new PlanError("network"))).toBe(true);
    expect(shouldRetryPlanWrite(6, new PlanError("network"))).toBe(false);
    expect(shouldRetryPlanWrite(0, new PlanError("forbidden"))).toBe(false);
    expect(shouldRetryPlanWrite(0, new Error("boom"))).toBe(false);
    expect([0, 1, 2, 3, 4, 5, 9].map(planRetryDelay)).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000,
    ]);
  });
});

describe("reading", () => {
  it("finds no plan for a week nobody has planned, and writes nothing while looking", async () => {
    const { client, server } = world();
    expect(await fetchMealPlan(client, HOUSEHOLD, "2026-11-05")).toBeNull();
    expect(await fetchMealPlanEntries(client, PLAN)).toEqual([]);
    expect(server.tables.meal_plans).toHaveLength(0);
    expect(server.requests().every((r) => r.op === "select")).toBe(true);
  });

  it("snaps any date in the week to the Monday it filters on", async () => {
    const { client, server } = world();
    await fetchMealPlan(client, HOUSEHOLD, "2026-11-05");
    const filters = server.requests("meal_plans")[0]?.filters;
    expect(filters).toContainEqual(["week_start", "eq", WEEK]);
    expect(filters).toContainEqual(["household_id", "eq", HOUSEHOLD]);
  });

  it("returns entries with their recipe, numeric servings, and in day then position order", async () => {
    const { client, server } = world();
    server.tables.meal_plan_entries?.push(
      {
        id: ENTRY_2,
        plan_id: PLAN,
        household_id: HOUSEHOLD,
        date: "2026-11-04",
        slot: "lunch",
        recipe_id: RECIPE_2,
        servings: "2",
        status: "planned",
        notes: null,
        position: 0,
        created_at: "2026-10-30T12:00:02.000Z",
        updated_at: "2026-10-30T12:00:02.000Z",
      },
      {
        id: ENTRY,
        plan_id: PLAN,
        household_id: HOUSEHOLD,
        date: TUESDAY,
        slot: "dinner",
        recipe_id: RECIPE,
        servings: 4,
        status: "planned",
        notes: null,
        position: 0,
        created_at: "2026-10-30T12:00:01.000Z",
        updated_at: "2026-10-30T12:00:01.000Z",
      },
    );
    const entries = await fetchMealPlanEntries(client, PLAN);
    expect(entries.map((e) => e.id)).toEqual([ENTRY, ENTRY_2]);
    expect(entries[1]?.servings).toBe(2);
    expect(entries[0]?.recipe?.title).toBe("Lemon chicken");
    expect(entries[0]).not.toHaveProperty("recipes");
  });

  it("lists recent recipes newest first, once each", async () => {
    const { client, server } = world();
    const row = (id: string, recipe_id: string, created_at: string) => ({
      id,
      household_id: HOUSEHOLD,
      recipe_id,
      created_at,
    });
    server.tables.meal_plan_entries?.push(
      row("e1", RECIPE, "2026-10-30T12:00:01.000Z"),
      row("e2", RECIPE_2, "2026-10-30T12:00:02.000Z"),
      row("e3", RECIPE, "2026-10-30T12:00:03.000Z"),
    );
    expect(await fetchRecentRecipeIds(client, HOUSEHOLD)).toEqual([RECIPE, RECIPE_2]);
    expect(
      distinctRecipeIds([{ recipe_id: "a" }, { recipe_id: "b" }, { recipe_id: "a" }], 1),
    ).toEqual(["a"]);
  });
});

describe("writing", () => {
  it("creates the week's plan with ON CONFLICT DO NOTHING and returns the winning row", async () => {
    const { client, server } = world();
    const plan = await ensureMealPlan(client, {
      householdId: HOUSEHOLD,
      weekStart: TUESDAY,
      planId: PLAN,
    });
    expect(plan).toMatchObject({ id: PLAN, household_id: HOUSEHOLD, week_start: WEEK });
    const upsert = server.requests("meal_plans", "upsert")[0];
    expect(upsert?.payload).toEqual({ id: PLAN, household_id: HOUSEHOLD, week_start: WEEK });
    expect(upsert?.options).toEqual({
      onConflict: "household_id,week_start",
      ignoreDuplicates: true,
    });
  });

  it("returns the other device's plan when it got there first", async () => {
    const { client, server } = world();
    server.tables.meal_plans?.push({ id: REMOTE_PLAN, household_id: HOUSEHOLD, week_start: WEEK });
    const plan = await ensureMealPlan(client, {
      householdId: HOUSEHOLD,
      weekStart: WEEK,
      planId: PLAN,
    });
    expect(plan.id).toBe(REMOTE_PLAN);
    expect(server.tables.meal_plans).toHaveLength(1);
  });

  it("inserts an entry as the example payload in the brief", async () => {
    const { client, server } = world();
    await insertEntry(client, {
      id: ENTRY,
      planId: PLAN,
      householdId: HOUSEHOLD,
      entry: { date: TUESDAY, slot: "dinner", recipe_id: RECIPE, servings: 4 },
    });
    const request = server.requests("meal_plan_entries", "upsert")[0];
    expect(request?.payload).toEqual({
      id: ENTRY,
      plan_id: PLAN,
      household_id: HOUSEHOLD,
      date: TUESDAY,
      slot: "dinner",
      recipe_id: RECIPE,
      servings: 4,
      status: "planned",
      notes: null,
      position: 0,
    });
    expect(request?.options).toEqual({ onConflict: "id", ignoreDuplicates: true });
  });

  it("repeating an insert with the same id leaves one row", async () => {
    const { client, server } = world();
    const row = {
      id: ENTRY,
      planId: PLAN,
      householdId: HOUSEHOLD,
      entry: { date: TUESDAY, slot: "dinner", recipe_id: RECIPE, servings: 4 } as const,
    };
    await insertEntry(client, row);
    await insertEntry(client, row);
    expect(server.tables.meal_plan_entries).toHaveLength(1);
  });

  it("refuses an invalid entry before sending anything", async () => {
    const { client, server } = world();
    await expect(
      insertEntry(client, {
        id: ENTRY,
        planId: PLAN,
        householdId: HOUSEHOLD,
        entry: { date: TUESDAY, slot: "dinner", recipe_id: RECIPE, servings: 0 },
      }),
    ).rejects.toThrow();
    expect(server.log).toHaveLength(0);
  });

  it("updates only the columns it is given", async () => {
    const { client, server, queryClient } = world();
    seedServer(server, seedEntry(queryClient));
    await patchEntry(client, ENTRY, { servings: 6 });
    const update = server.requests("meal_plan_entries", "update")[0];
    expect(update?.payload).toEqual({ servings: 6 });
    expect(server.tables.meal_plan_entries?.[0]).toMatchObject({ servings: 6, slot: "dinner" });
  });

  it("sends nothing for an empty patch, and says not_found for a missing entry", async () => {
    const { client, server } = world();
    await patchEntry(client, ENTRY, {});
    expect(server.log).toHaveLength(0);
    await expect(patchEntry(client, ENTRY, { servings: 2 })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("deleting twice is fine", async () => {
    const { client, server, queryClient } = world();
    seedServer(server, seedEntry(queryClient));
    await removeEntry(client, ENTRY);
    await removeEntry(client, ENTRY);
    expect(server.tables.meal_plan_entries).toHaveLength(0);
  });

  it("reports a dropped connection as a retryable network error", async () => {
    const { client, server } = world();
    server.offline = true;
    await expect(removeEntry(client, ENTRY)).rejects.toMatchObject({ code: "network" });
  });
});

describe("cache edits", () => {
  const entry = (over: Partial<PlanEntry> = {}): PlanEntry => ({
    id: ENTRY,
    plan_id: PLAN,
    household_id: HOUSEHOLD,
    date: TUESDAY,
    slot: "dinner",
    recipe_id: RECIPE,
    servings: 4,
    status: "planned",
    notes: null,
    position: 0,
    created_at: "2026-10-30T12:00:00.000Z",
    updated_at: "2026-10-30T12:00:00.000Z",
    recipe: lemonChicken,
    ...over,
  });

  it("replaces by id instead of duplicating", () => {
    const once = withEntry(undefined, entry());
    const twice = withEntry(once, entry({ servings: 8 }));
    expect(twice).toHaveLength(1);
    expect(twice[0]?.servings).toBe(8);
  });

  it("removes and patches without touching the input", () => {
    const list = [entry(), entry({ id: ENTRY_2, position: 1 })];
    expect(withoutEntry(list, ENTRY).map((e) => e.id)).toEqual([ENTRY_2]);
    expect(withPatch(list, ENTRY_2, { servings: 2 })[1]?.servings).toBe(2);
    expect(list[1]?.servings).toBe(4);
    expect(withoutEntry(undefined, ENTRY)).toEqual([]);
  });

  it("works out the inverse of a patch for rollback", () => {
    expect(inversePatch(entry({ servings: 4, notes: "hi" }), { servings: 6, notes: null })).toEqual(
      {
        servings: 4,
        notes: "hi",
      },
    );
  });
});

describe("useUpsertEntry: adding", () => {
  it("shows the entry at once, and creates the plan only when the first entry is saved", async () => {
    const { client, server, queryClient } = world();
    // Looking at the week creates nothing (acceptance criterion 2).
    expect(await fetchMealPlan(client, HOUSEHOLD, WEEK)).toBeNull();
    expect(server.tables.meal_plans).toHaveLength(0);

    let release: () => void = () => {};
    server.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const observer = new MutationObserver(queryClient, upsertEntryOptions(client, queryClient));
    const done = observer.mutate(addInput());

    // In flight: the screen already has the entry and a plan, the database has neither.
    await until(
      () =>
        (queryClient.getQueryData<PlanEntry[]>(mealPlanEntriesKey(HOUSEHOLD, PLAN)) ?? [])
          .length === 1,
      "the optimistic entry",
    );
    expect(
      queryClient.getQueryData<PlanEntry[]>(mealPlanEntriesKey(HOUSEHOLD, PLAN))?.[0],
    ).toMatchObject({
      id: ENTRY,
      slot: "dinner",
      servings: 4,
      status: "planned",
      recipe: { title: "Lemon chicken" },
    });
    expect(queryClient.getQueryData<MealPlan>(mealPlanKey(HOUSEHOLD, WEEK))?.id).toBe(PLAN);
    expect(server.tables.meal_plans).toHaveLength(0);
    expect(server.tables.meal_plan_entries).toHaveLength(0);

    release();
    const result = await done;
    expect(result.planId).toBe(PLAN);
    expect(server.tables.meal_plans).toHaveLength(1);
    expect(server.tables.meal_plan_entries).toHaveLength(1);
    expect(server.tables.meal_plan_entries?.[0]).toMatchObject({
      plan_id: PLAN,
      household_id: HOUSEHOLD,
      date: TUESDAY,
      slot: "dinner",
      recipe_id: RECIPE,
      servings: 4,
      status: "planned",
    });
  });

  it("adds to a week that already has a plan without touching meal_plans", async () => {
    const { client, server, queryClient } = world();
    seedServer(server, seedEntry(queryClient));
    server.log.length = 0;
    const observer = new MutationObserver(queryClient, upsertEntryOptions(client, queryClient));
    await observer.mutate(
      addInput({
        id: ENTRY_2,
        planIsNew: false,
        entry: { date: TUESDAY, slot: "lunch", recipe_id: RECIPE_2, servings: 2, position: 0 },
      }),
    );
    expect(server.requests("meal_plans", "upsert")).toHaveLength(0);
    expect(server.tables.meal_plan_entries).toHaveLength(2);
  });

  it("marks the plan key stale, which is how the grocery list learns it is out of date", async () => {
    const { client, queryClient } = world();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const observer = new MutationObserver(queryClient, upsertEntryOptions(client, queryClient));
    await observer.mutate(addInput());
    const keys = invalidate.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(["meal-plan", HOUSEHOLD, WEEK]));
  });

  it("rolls back and reports the error when the database refuses", async () => {
    const { client, server, queryClient } = world();
    server.failures = [
      { message: "permission denied for table meal_plans", code: "42501", status: 403 },
    ];
    const observer = new MutationObserver(queryClient, upsertEntryOptions(client, queryClient));
    await expect(observer.mutate(addInput())).rejects.toMatchObject({ code: "forbidden" });
    expect(
      queryClient.getQueryData<PlanEntry[]>(mealPlanEntriesKey(HOUSEHOLD, PLAN)) ?? [],
    ).toHaveLength(0);
    expect(server.requests()).toHaveLength(1); // not retried: a refusal will not change
    expect(server.tables.meal_plan_entries).toHaveLength(0);
  });

  it("puts back a plan the cache knew was missing", async () => {
    const { client, server, queryClient } = world();
    queryClient.setQueryData(mealPlanKey(HOUSEHOLD, WEEK), null);
    server.failures = [{ message: "boom", code: "XX000", status: 400 }];
    const observer = new MutationObserver(queryClient, upsertEntryOptions(client, queryClient));
    await expect(observer.mutate(addInput())).rejects.toBeInstanceOf(PlanError);
    expect(queryClient.getQueryData(mealPlanKey(HOUSEHOLD, WEEK))).toBeNull();
  });

  it("rejects an invalid entry before touching the cache or the network", async () => {
    const { client, server, queryClient } = world();
    const observer = new MutationObserver(queryClient, upsertEntryOptions(client, queryClient));
    await expect(
      observer.mutate(
        addInput({ entry: { date: TUESDAY, slot: "dinner", recipe_id: RECIPE, servings: -1 } }),
      ),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(server.log).toHaveLength(0);
    expect(queryClient.getQueryData(mealPlanEntriesKey(HOUSEHOLD, PLAN))).toBeUndefined();
  });

  it("uses the plan another device created first and moves the optimistic list onto it", async () => {
    const { client, server, queryClient } = world();
    server.tables.meal_plans?.push({
      id: REMOTE_PLAN,
      household_id: HOUSEHOLD,
      week_start: WEEK,
      created_at: "2026-10-30T11:00:00.000Z",
      updated_at: "2026-10-30T11:00:00.000Z",
    });
    const observer = new MutationObserver(queryClient, upsertEntryOptions(client, queryClient));
    const result = await observer.mutate(addInput());
    expect(result.planId).toBe(REMOTE_PLAN);
    expect(server.tables.meal_plans).toHaveLength(1);
    expect(server.tables.meal_plan_entries?.[0]).toMatchObject({ plan_id: REMOTE_PLAN });
    expect(queryClient.getQueryData(mealPlanKey(HOUSEHOLD, WEEK))).toMatchObject({
      id: REMOTE_PLAN,
    });
    expect(
      queryClient.getQueryData<PlanEntry[]>(mealPlanEntriesKey(HOUSEHOLD, PLAN)),
    ).toBeUndefined();
  });
});

describe("useUpsertEntry: connection trouble (acceptance criterion 6)", () => {
  it("retries a dropped connection with the same ids and ends with one entry", async () => {
    const { client, server, queryClient } = world();
    server.failures = [OFFLINE, OFFLINE];
    const observer = new MutationObserver(queryClient, {
      ...upsertEntryOptions(client, queryClient),
      retryDelay: 0,
    });
    await observer.mutate(addInput());
    expect(server.tables.meal_plan_entries).toHaveLength(1);
    expect(server.tables.meal_plans).toHaveLength(1);
    const sentIds = server
      .requests("meal_plan_entries", "upsert")
      .map((r) => (r.payload as { id: string }).id);
    expect(new Set(sentIds)).toEqual(new Set([ENTRY]));
  });

  it("does not add a second entry when the insert landed but the answer was lost", async () => {
    const { client, server, queryClient } = world();
    seedServer(server, seedEntry(queryClient));
    server.log.length = 0;
    // The first attempt writes the row, then the response never arrives.
    server.failures = [{ ...OFFLINE, afterApply: true }];
    const observer = new MutationObserver(queryClient, {
      ...upsertEntryOptions(client, queryClient),
      retryDelay: 0,
    });
    await observer.mutate(
      addInput({
        id: ENTRY_2,
        planIsNew: false,
        entry: { date: TUESDAY, slot: "lunch", recipe_id: RECIPE_2, servings: 2 },
      }),
    );
    expect(server.requests("meal_plan_entries", "upsert")).toHaveLength(2);
    expect(server.tables.meal_plan_entries?.filter((row) => row.id === ENTRY_2)).toHaveLength(1);
    expect(server.tables.meal_plan_entries).toHaveLength(2);
  });

  it("keeps a servings change on screen while offline, then saves it once on reconnect", async () => {
    const { client, server, queryClient } = world();
    seedServer(server, seedEntry(queryClient));
    server.log.length = 0;
    server.offline = true; // airplane mode on
    server.onRequest = () => {
      // Three failed tries later the network is back.
      if (server.log.length >= 4) server.offline = false;
    };
    const observer = new MutationObserver(queryClient, {
      ...upsertEntryOptions(client, queryClient),
      retryDelay: 5,
    });
    const done = observer.mutate({
      mode: "edit",
      id: ENTRY,
      householdId: HOUSEHOLD,
      planId: PLAN,
      patch: { servings: 6 },
    });

    await until(() => server.log.length >= 2, "the first retries");
    expect(
      queryClient.getQueryData<PlanEntry[]>(mealPlanEntriesKey(HOUSEHOLD, PLAN))?.[0]?.servings,
    ).toBe(6);
    expect(server.tables.meal_plan_entries?.[0]?.servings).toBe(4); // not saved yet

    await done;
    expect(server.tables.meal_plan_entries).toHaveLength(1);
    expect(server.tables.meal_plan_entries?.[0]).toMatchObject({ id: ENTRY, servings: 6 });
    expect(server.requests("meal_plan_entries", "update").filter((r) => !r.failed)).toHaveLength(1);
  });

  it("gives up after the retries and puts the old servings back", async () => {
    const { client, server, queryClient } = world();
    seedServer(server, seedEntry(queryClient));
    server.offline = true;
    const observer = new MutationObserver(queryClient, {
      ...upsertEntryOptions(client, queryClient),
      retryDelay: 0,
    });
    await expect(
      observer.mutate({
        mode: "edit",
        id: ENTRY,
        householdId: HOUSEHOLD,
        planId: PLAN,
        patch: { servings: 6 },
      }),
    ).rejects.toMatchObject({ code: "network" });
    expect(
      queryClient.getQueryData<PlanEntry[]>(mealPlanEntriesKey(HOUSEHOLD, PLAN))?.[0]?.servings,
    ).toBe(4);
    expect(server.tables.meal_plan_entries?.[0]?.servings).toBe(4);
  });
});

describe("useUpsertEntry: editing", () => {
  it("applies a status change on screen at once and saves only that column", async () => {
    const { client, server, queryClient } = world();
    seedServer(server, seedEntry(queryClient));
    const observer = new MutationObserver(queryClient, upsertEntryOptions(client, queryClient));
    await observer.mutate({
      mode: "edit",
      id: ENTRY,
      householdId: HOUSEHOLD,
      planId: PLAN,
      patch: { status: "cooked" },
    });
    expect(server.requests("meal_plan_entries", "update")[0]?.payload).toEqual({
      status: "cooked",
    });
    expect(server.tables.meal_plan_entries?.[0]).toMatchObject({ status: "cooked", servings: 4 });
  });

  it("swaps the recipe, showing the new title straight away, and restores the old one on failure", async () => {
    const { client, server, queryClient } = world();
    seedServer(server, seedEntry(queryClient));
    server.failures = [{ message: "recipe_not_found", code: "P0001", status: 400 }];
    const observer = new MutationObserver(queryClient, upsertEntryOptions(client, queryClient));
    let release: () => void = () => {};
    server.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const done = observer.mutate({
      mode: "edit",
      id: ENTRY,
      householdId: HOUSEHOLD,
      planId: PLAN,
      patch: { recipe_id: RECIPE_2 },
      recipe: greenCurry,
    });
    const current = () =>
      queryClient.getQueryData<PlanEntry[]>(mealPlanEntriesKey(HOUSEHOLD, PLAN))?.[0];
    await until(() => current()?.recipe?.title === "Green curry", "the optimistic swap");
    release();
    await expect(done).rejects.toMatchObject({ code: "not_found" });
    expect(current()).toMatchObject({ recipe_id: RECIPE, recipe: { title: "Lemon chicken" } });
  });

  it("does not undo a second tap that landed while the first was failing", async () => {
    const { client, server, queryClient } = world();
    seedServer(server, seedEntry(queryClient));
    server.failures = [{ message: "boom", code: "XX000", status: 400 }];
    let release: () => void = () => {};
    server.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const observerA = new MutationObserver(queryClient, upsertEntryOptions(client, queryClient));
    const observerB = new MutationObserver(queryClient, upsertEntryOptions(client, queryClient));
    const first = observerA.mutate({
      mode: "edit",
      id: ENTRY,
      householdId: HOUSEHOLD,
      planId: PLAN,
      patch: { servings: 6 },
    });
    const second = observerB.mutate({
      mode: "edit",
      id: ENTRY,
      householdId: HOUSEHOLD,
      planId: PLAN,
      patch: { notes: "less salt" },
    });
    const current = () =>
      queryClient.getQueryData<PlanEntry[]>(mealPlanEntriesKey(HOUSEHOLD, PLAN))?.[0];
    await until(
      () => current()?.servings === 6 && current()?.notes === "less salt",
      "both optimistic edits",
    );
    release();
    await expect(first).rejects.toBeInstanceOf(PlanError);
    await second;
    expect(current()).toMatchObject({ servings: 4, notes: "less salt" });
  });
});

describe("a burst of saves", () => {
  it("runs them in the order they were made and refetches once, at the end", async () => {
    const { client, server, queryClient } = world();
    seedServer(server, seedEntry(queryClient));
    server.log.length = 0;
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const edit = (servings: number) =>
      new MutationObserver(queryClient, upsertEntryOptions(client, queryClient)).mutate({
        mode: "edit",
        id: ENTRY,
        householdId: HOUSEHOLD,
        planId: PLAN,
        patch: { servings },
      });

    // Three quick taps on the plus button: the screen has 7 before any request has answered.
    const done = [edit(5), edit(6), edit(7)];
    const current = () =>
      queryClient.getQueryData<PlanEntry[]>(mealPlanEntriesKey(HOUSEHOLD, PLAN))?.[0]?.servings;
    await until(() => current() === 7, "all three optimistic edits");
    await Promise.all(done);

    const sent = server
      .requests("meal_plan_entries", "update")
      .map((r) => (r.payload as { servings: number }).servings);
    expect(sent).toEqual([5, 6, 7]);
    expect(server.tables.meal_plan_entries?.[0]?.servings).toBe(7);
    const planKeyInvalidations = invalidate.mock.calls.filter(
      (call) => JSON.stringify(call[0]?.queryKey) === JSON.stringify(mealPlanKey(HOUSEHOLD, WEEK)),
    );
    expect(planKeyInvalidations).toHaveLength(1);
  });

  it("counts the saves that have not finished", async () => {
    const { client, server, queryClient } = world();
    seedServer(server, seedEntry(queryClient));
    let release: () => void = () => {};
    server.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    expect(planWritesPending(queryClient)).toBe(0);
    const done = new MutationObserver(queryClient, upsertEntryOptions(client, queryClient)).mutate({
      mode: "edit",
      id: ENTRY,
      householdId: HOUSEHOLD,
      planId: PLAN,
      patch: { servings: 5 },
    });
    await until(() => planWritesPending(queryClient) === 1, "the save to start");
    release();
    await done;
    expect(planWritesPending(queryClient)).toBe(0);
  });

  it("tells the caller about a failure after the cache is back to normal", async () => {
    const { client, server, queryClient } = world();
    seedServer(server, seedEntry(queryClient));
    server.failures = [{ message: "permission denied", code: "42501", status: 403 }];
    const seen: Array<{ code: string; servings: number | undefined; mode: string }> = [];
    const observer = new MutationObserver(
      queryClient,
      upsertEntryOptions(client, queryClient, (error, input) => {
        seen.push({
          code: (error as PlanError).code,
          mode: input.mode,
          servings: queryClient.getQueryData<PlanEntry[]>(mealPlanEntriesKey(HOUSEHOLD, PLAN))?.[0]
            ?.servings,
        });
      }),
    );
    await expect(
      observer.mutate({
        mode: "edit",
        id: ENTRY,
        householdId: HOUSEHOLD,
        planId: PLAN,
        patch: { servings: 9 },
      }),
    ).rejects.toBeInstanceOf(PlanError);
    expect(seen).toEqual([{ code: "forbidden", mode: "edit", servings: 4 }]);
  });
});

describe("useDeleteEntry", () => {
  const input: DeleteEntryInput = { id: ENTRY, householdId: HOUSEHOLD, planId: PLAN };

  it("removes the entry from the screen at once and from the database", async () => {
    const { client, server, queryClient } = world();
    seedServer(server, seedEntry(queryClient));
    const observer = new MutationObserver(queryClient, deleteEntryOptions(client, queryClient));
    await observer.mutate(input);
    expect(server.tables.meal_plan_entries).toHaveLength(0);
    expect(queryClient.getQueryData<PlanEntry[]>(mealPlanEntriesKey(HOUSEHOLD, PLAN))).toEqual([]);
  });

  it("brings the entry back where it was if the delete fails", async () => {
    const { client, server, queryClient } = world();
    seedServer(server, seedEntry(queryClient));
    server.failures = [{ message: "permission denied", code: "42501", status: 403 }];
    const observer = new MutationObserver(queryClient, deleteEntryOptions(client, queryClient));
    await expect(observer.mutate(input)).rejects.toMatchObject({ code: "forbidden" });
    expect(
      queryClient.getQueryData<PlanEntry[]>(mealPlanEntriesKey(HOUSEHOLD, PLAN))?.map((e) => e.id),
    ).toEqual([ENTRY]);
    expect(server.tables.meal_plan_entries).toHaveLength(1);
  });

  it("marks the entry's week stale", async () => {
    const { client, server, queryClient } = world();
    seedServer(server, seedEntry(queryClient));
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const observer = new MutationObserver(queryClient, deleteEntryOptions(client, queryClient));
    await observer.mutate(input);
    const keys = invalidate.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(["meal-plan", HOUSEHOLD, WEEK]));
  });
});

describe("invalidateMealPlan", () => {
  it("marks every week when it does not know which one changed", async () => {
    const queryClient = newQueryClient();
    queryClient.setQueryData(mealPlanKey(HOUSEHOLD, WEEK), null);
    queryClient.setQueryData(mealPlanKey(HOUSEHOLD, "2026-11-09"), null);
    await invalidateMealPlan(queryClient, { householdId: HOUSEHOLD, weekStart: null });
    expect(queryClient.getQueryState(mealPlanKey(HOUSEHOLD, WEEK))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(mealPlanKey(HOUSEHOLD, "2026-11-09"))?.isInvalidated).toBe(
      true,
    );
  });

  it("marks only the changed week when it knows", async () => {
    const queryClient = newQueryClient();
    queryClient.setQueryData(mealPlanKey(HOUSEHOLD, WEEK), null);
    queryClient.setQueryData(mealPlanKey(HOUSEHOLD, "2026-11-09"), null);
    await invalidateMealPlan(queryClient, { householdId: HOUSEHOLD, weekStart: WEEK });
    expect(queryClient.getQueryState(mealPlanKey(HOUSEHOLD, WEEK))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(mealPlanKey(HOUSEHOLD, "2026-11-09"))?.isInvalidated).toBe(
      false,
    );
  });
});

describe("thumbs", () => {
  const row = (signal: "like" | "dislike" | "saved", created_at: string, recipe_id = RECIPE) => ({
    signal,
    created_at,
    recipe_id,
  });

  it("reads the newest like or dislike as the current thumb", () => {
    expect(currentThumb([])).toBeNull();
    expect(currentThumb(undefined)).toBeNull();
    expect(currentThumb([row("saved", "2026-10-30T12:00:05Z")])).toBeNull();
    expect(
      currentThumb([
        row("like", "2026-10-30T12:00:01Z"),
        row("dislike", "2026-10-30T12:00:02Z"),
        row("saved", "2026-10-30T12:00:09Z"),
      ]),
    ).toBe("dislike");
  });

  it("lists recipes whose latest thumb is a like, newest first", () => {
    const rows = [
      row("like", "2026-10-30T12:00:01Z", "r1"),
      row("dislike", "2026-10-30T12:00:03Z", "r1"), // changed their mind
      row("like", "2026-10-30T12:00:02Z", "r2"),
      row("like", "2026-10-30T12:00:04Z", "r3"),
      row("saved", "2026-10-30T12:00:05Z", "r4"),
    ];
    expect(favoriteIds(rows)).toEqual(["r3", "r2"]);
  });

  it("writes the new thumb first, then removes the older ones", async () => {
    const { client, server } = world();
    server.tables.recipe_feedback?.push({
      id: "old",
      household_id: HOUSEHOLD,
      user_id: USER,
      recipe_id: RECIPE,
      signal: "dislike",
      created_at: "2026-10-30T11:00:00.000Z",
    });
    await setThumb(
      client,
      USER,
      { householdId: HOUSEHOLD, recipeId: RECIPE, thumb: "like" },
      "new-thumb",
    );
    const ops = server.log.map((r) => r.op);
    expect(ops).toEqual(["upsert", "delete"]);
    expect(server.tables.recipe_feedback?.map((r) => [r.id, r.signal])).toEqual([
      ["new-thumb", "like"],
    ]);
  });

  it("takes a thumb back by deleting the caller's thumbs and writing nothing", async () => {
    const { client, server } = world();
    server.tables.recipe_feedback?.push({
      id: "old",
      household_id: HOUSEHOLD,
      user_id: USER,
      recipe_id: RECIPE,
      signal: "like",
      created_at: "2026-10-30T11:00:00.000Z",
    });
    await setThumb(client, USER, { householdId: HOUSEHOLD, recipeId: RECIPE, thumb: null });
    expect(server.log.map((r) => r.op)).toEqual(["delete"]);
    expect(server.tables.recipe_feedback).toHaveLength(0);
  });

  it("shows the thumb at once and rolls it back on failure", async () => {
    const { client, server, queryClient } = world();
    const key = ["recipe-feedback", USER, RECIPE];
    queryClient.setQueryData(key, []);
    server.failures = [{ message: "permission denied", code: "42501", status: 403 }];
    let release: () => void = () => {};
    server.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const observer = new MutationObserver(queryClient, setThumbOptions(client, queryClient, USER));
    const done = observer.mutate({ householdId: HOUSEHOLD, recipeId: RECIPE, thumb: "like" });
    await until(
      () => currentThumb(queryClient.getQueryData(key)) === "like",
      "the optimistic thumb",
    );
    release();
    await expect(done).rejects.toMatchObject({ code: "forbidden" });
    expect(currentThumb(queryClient.getQueryData(key))).toBeNull();
  });
});

describe("ids", () => {
  afterEach(() => setIdGenerator(undefined));

  it("makes version 4 UUIDs and no two alike", () => {
    const a = newId();
    const b = newId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });

  it("uses an injected generator, such as expo-crypto's", () => {
    setIdGenerator(() => ENTRY);
    expect(newId()).toBe(ENTRY);
  });

  it("falls back to Math.random when the runtime has no Web Crypto", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
    try {
      expect(newId()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    } finally {
      if (original) Object.defineProperty(globalThis, "crypto", original);
    }
  });
});

describe("week plumbing the hooks rely on", () => {
  beforeEach(() => setIdGenerator(undefined));

  it("keys a week by its Monday whatever date is asked for", () => {
    expect(mealPlanKey(HOUSEHOLD, weekStartFor("2026-11-08"))).toEqual(
      mealPlanKey(HOUSEHOLD, WEEK),
    );
    expect(weekDates(WEEK)).toContain(TUESDAY);
  });

  it("accepts the brief's example payload as an entry input", () => {
    const parsed = MealPlanEntryInput.parse({
      date: TUESDAY,
      slot: "dinner",
      recipe_id: RECIPE,
      servings: 4,
      status: "planned",
      position: 0,
    });
    expect(parsed).toMatchObject({ slot: "dinner", servings: 4, status: "planned", position: 0 });
  });
});
