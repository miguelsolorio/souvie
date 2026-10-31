// The store's SQL on a real Postgres (PGlite, see testing/db.ts), with the repo's own migrations.
// The pure rules are tested in packages/core/src/list; what is tested here is that the SQL reads
// the right rows, writes what buildList decided, keeps check-offs and manual items on a rebuild,
// and runs as service_role.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildList, planFingerprint } from "../../../packages/core/src/index.ts";
import { inputOf, type ListFixture } from "../../../packages/core/src/list/fixtures/harness.ts";
import { FIXTURES } from "../../../packages/core/src/list/fixtures/index.ts";
import type { SqlRunner } from "./sql.ts";
import { listNameFor, NoPlanError, SERVICE_ROLE_STATEMENT, SqlListStore } from "./store.ts";
import { createListTestDb, type TestDb } from "./testing/db.ts";
import { HOUSEHOLD_ID, insertHousehold, seedFixture, USER_ID, WEEK_START } from "./testing/seed.ts";

const WEEK = FIXTURES["week-of-five-dinners"] as ListFixture;
const NOW = new Date("2026-11-01T18:00:00.000Z");

let t: TestDb;
let store: SqlListStore;

beforeEach(async () => {
  t = await createListTestDb();
  store = new SqlListStore(t.runner);
}, 120_000);

afterEach(async () => {
  await t.close();
});

interface ItemRow {
  id: string;
  ingredient_id: string | null;
  display_name: string;
  qty: number | null;
  unit: string | null;
  section: string;
  checked: boolean;
  checked_by: string | null;
  excluded_reason: string | null;
  needs_attention: boolean;
  is_manual: boolean;
  position: number;
  qualifiers: string[];
  edited: boolean;
  source_entry_ids: string[];
  detail: { contributions: unknown[]; rounding?: unknown; attention?: string | null };
}

async function itemsOf(listId: string): Promise<ItemRow[]> {
  return t.query<ItemRow>(
    `select id, ingredient_id, display_name, qty::float8 as qty, unit, section, checked, checked_by,
            excluded_reason::text as excluded_reason, needs_attention, is_manual, position,
            qualifiers, edited, source_entry_ids, detail
       from public.grocery_list_items where list_id = $1 order by position, id`,
    [listId],
  );
}

describe("build: the week of five dinners", () => {
  it("writes exactly the list buildList decides, as one list for the plan", async () => {
    const seeded = await seedFixture(t, WEEK);
    const result = await store.build({
      householdId: seeded.householdId,
      weekStart: seeded.weekStart,
      now: NOW,
    });

    const draft = buildList(inputOf(WEEK, seeded.ids));
    expect(result).toMatchObject({
      ok: true,
      rebuilt: false,
      planVersion: 1,
      skippedEntryCount: 0,
      needsAttentionCount: 4,
    });
    expect(result.itemCount).toBe(draft.items.filter((i) => !i.excludedReason).length);
    expect(result.alreadyHaveCount).toBe(draft.items.filter((i) => i.excludedReason).length);

    const rows = await itemsOf(result.listId);
    expect(rows).toHaveLength(draft.items.length);
    for (const [index, item] of draft.items.entries()) {
      const row = rows[index];
      expect(row?.display_name, `item ${index}`).toBe(item.displayName);
      expect(row?.qty).toBe(item.qty);
      expect(row?.unit).toBe(item.unit);
      expect(row?.section).toBe(item.section);
      expect(row?.excluded_reason).toBe(item.excludedReason ?? null);
      expect(row?.needs_attention).toBe(item.needsAttention);
      expect(row?.position).toBe(item.position);
      expect(row?.source_entry_ids).toEqual(item.sourceEntryIds);
      expect(row?.detail.contributions).toHaveLength(item.contributions.length);
      expect(row?.checked).toBe(false);
      expect(row?.is_manual).toBe(false);
    }

    // needsAttentionCount is the number of lines with no ingredient (criterion 3).
    const unplaced = WEEK.recipes.flatMap((r) => r.lines).filter((l) => l.ingredient === null);
    expect(result.needsAttentionCount).toBe(unplaced.length);
    expect(
      rows
        .filter((r) => r.ingredient_id === null)
        .map((r) => r.display_name)
        .sort(),
    ).toEqual(unplaced.map((l) => l.text).sort());

    const lists = await t.query<{
      plan_id: string;
      name: string;
      status: string;
      plan_version: number;
      plan_fingerprint: string;
      built_at: string;
    }>(
      `select plan_id, name, status::text as status, plan_version, plan_fingerprint,
              built_at::text as built_at
         from public.grocery_lists where household_id = $1`,
      [seeded.householdId],
    );
    expect(lists).toHaveLength(1);
    expect(lists[0]).toMatchObject({
      plan_id: seeded.planId,
      name: "Week of Nov 2",
      status: "active",
      plan_version: 1,
    });
    const entries = inputOf(WEEK, seeded.ids).entries;
    expect(lists[0]?.plan_fingerprint).toBe(planFingerprint(entries));
  });

  it("builds in well under two seconds (PGlite stand-in)", async () => {
    const seeded = await seedFixture(t, WEEK);
    const started = Date.now();
    await store.build({ householdId: seeded.householdId, weekStart: seeded.weekStart, now: NOW });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(2000);
    console.info(
      `list-build store.build on PGlite: ${elapsed} ms for ${WEEK.entries.length} dinners`,
    );
  });

  it("reads catalog recipes the household did not write", async () => {
    const seeded = await seedFixture(t, WEEK);
    await t.query(`update public.recipes set household_id = null, visibility = 'catalog'`);
    const result = await store.build({
      householdId: seeded.householdId,
      weekStart: seeded.weekStart,
      now: NOW,
    });
    expect(result.itemCount).toBeGreaterThan(20);
    expect(result.skippedEntryCount).toBe(0);
  });

  it("reports entries whose recipe is gone and still builds the rest", async () => {
    const seeded = await seedFixture(t, WEEK);
    await t.query(
      `update public.recipes set deleted_at = now()
        where id = (select recipe_id from public.meal_plan_entries limit 1)`,
    );
    const result = await store.build({
      householdId: seeded.householdId,
      weekStart: seeded.weekStart,
      now: NOW,
    });
    expect(result.skippedEntryCount).toBe(1);
    expect(result.itemCount).toBeGreaterThan(10);
  });

  it("says so when the week has no plan", async () => {
    await insertHousehold(t, { userId: USER_ID, householdId: HOUSEHOLD_ID });
    await expect(
      store.build({ householdId: HOUSEHOLD_ID, weekStart: WEEK_START, now: NOW }),
    ).rejects.toBeInstanceOf(NoPlanError);
  });

  it("builds an empty list for a plan with no dinners left", async () => {
    const seeded = await seedFixture(t, WEEK);
    await t.query(`delete from public.meal_plan_entries`);
    const result = await store.build({
      householdId: seeded.householdId,
      weekStart: seeded.weekStart,
      now: NOW,
    });
    expect(result).toMatchObject({ itemCount: 0, needsAttentionCount: 0, alreadyHaveCount: 0 });
  });
});

describe("rebuild (acceptance criterion 4)", () => {
  async function firstBuild() {
    const seeded = await seedFixture(t, WEEK);
    const result = await store.build({
      householdId: seeded.householdId,
      weekStart: seeded.weekStart,
      now: NOW,
    });
    return { seeded, listId: result.listId };
  }

  it("keeps checked items, manual items, edits and removals when the plan changes", async () => {
    const { seeded, listId } = await firstBuild();
    const before = await itemsOf(listId);
    const byName = (name: string, rows = before) => rows.find((r) => r.display_name === name);

    // What people did on the first list.
    const chicken = byName("Chicken breast");
    const flank = byName("Flank steak");
    const garlic = byName("Garlic");
    const lemon = byName("Lemon");
    const cabbage = byName("Cabbage");
    if (!chicken || !flank || !garlic || !lemon || !cabbage) throw new Error("fixture changed");
    await t.query(
      `update public.grocery_list_items
          set checked = true, checked_by = $2, checked_at = '2026-11-01 17:00:00+00'
        where id = any($1::uuid[])`,
      [[chicken.id, flank.id, lemon.id], USER_ID],
    );
    await t.query(
      `insert into public.grocery_list_items (list_id, household_id, display_name, qty, section, is_manual, position)
       values ($1, $2, 'Paper towels', 2, 'household', true, 5000)`,
      [listId, seeded.householdId],
    );
    await t.query(
      `update public.grocery_list_items set qty = 6, unit = 'cup', edited = true where id = $1`,
      [cabbage.id],
    );
    await t.query(`update public.grocery_list_items set excluded_reason = 'manual' where id = $1`, [
      garlic.id,
    ]);

    // The plan changes: the beef dinner is dropped and a new dinner is added.
    const beef = seeded.ids.of("entry:e-beef-and-broccoli-stir-fry");
    await t.query(`delete from public.meal_plan_entries where id = $1`, [beef]);
    const newRecipe = "55555555-5555-4555-8555-555555555555";
    await t.query(
      `insert into public.recipes (id, household_id, title, source_type, servings)
       values ($1, $2, 'Lemon Pasta', 'manual', 4)`,
      [newRecipe, seeded.householdId],
    );
    const shrimp = (
      await t.query<{ id: string }>(`select id from public.ingredients where name = 'shrimp'`)
    )[0]?.id;
    await t.query(
      `insert into public.recipe_ingredients (recipe_id, position, raw_text, qty, unit, ingredient_id)
       values ($1, 0, '1 lb shrimp', 1, 'lb', $2)`,
      [newRecipe, shrimp],
    );
    await t.query(
      `insert into public.meal_plan_entries (plan_id, household_id, date, slot, recipe_id, servings)
       values ($1, $2, '2026-11-07', 'dinner', $3, 4)`,
      [seeded.planId, seeded.householdId, newRecipe],
    );

    const result = await store.build({
      householdId: seeded.householdId,
      weekStart: seeded.weekStart,
      now: new Date("2026-11-02T08:00:00.000Z"),
    });
    expect(result).toMatchObject({ listId, rebuilt: true, planVersion: 2 });

    const after = await itemsOf(listId);
    expect(new Set(after.map((r) => r.id)).size).toBe(after.length);

    // Checked state survives on ingredients that are still planned: same row, same checker.
    const chickenAfter = byName("Chicken breast", after);
    const lemonAfter = byName("Lemon", after);
    expect(chickenAfter?.id).toBe(chicken.id);
    expect(chickenAfter).toMatchObject({ checked: true, checked_by: USER_ID });
    expect(lemonAfter?.id).toBe(lemon.id);
    expect(lemonAfter?.checked).toBe(true);
    // The flank steak was only in the dropped dinner: gone, checked or not.
    expect(byName("Flank steak", after)).toBeUndefined();
    // The manual item and the person's edits are still there.
    expect(byName("Paper towels", after)).toMatchObject({ is_manual: true, qty: 2 });
    expect(byName("Cabbage", after)).toMatchObject({
      id: cabbage.id,
      qty: 6,
      unit: "cup",
      edited: true,
    });
    expect(byName("Garlic", after)).toMatchObject({ id: garlic.id, excluded_reason: "manual" });
    // The new dinner's ingredient arrived unchecked.
    expect(byName("Shrimp", after)).toMatchObject({ checked: false, qty: 1, unit: "lb" });

    const lists = await t.query<{ plan_version: number; plan_fingerprint: string }>(
      `select plan_version, plan_fingerprint from public.grocery_lists where id = $1`,
      [listId],
    );
    expect(lists[0]?.plan_version).toBe(2);
    const entryRows = await t.query<{
      id: string;
      recipe_id: string;
      servings: number;
      status: string;
    }>(
      `select id, recipe_id, servings::float8 as servings, status::text as status
         from public.meal_plan_entries where plan_id = $1`,
      [seeded.planId],
    );
    expect(lists[0]?.plan_fingerprint).toBe(planFingerprint(entryRows));
    expect(lists[0]?.plan_fingerprint).not.toBe(planFingerprint(inputOf(WEEK, seeded.ids).entries));
    expect(
      (await t.query(`select 1 from public.grocery_lists where plan_id = $1`, [seeded.planId]))
        .length,
    ).toBe(1);
  });

  it("changes nothing when the plan did not change, and does not touch updated_at", async () => {
    const { seeded, listId } = await firstBuild();
    const before = await t.query<{ id: string; updated_at: string }>(
      `select id, updated_at::text as updated_at from public.grocery_list_items where list_id = $1 order by id`,
      [listId],
    );
    await store.build({
      householdId: seeded.householdId,
      weekStart: seeded.weekStart,
      now: new Date("2026-11-02T08:00:00.000Z"),
    });
    const after = await t.query<{ id: string; updated_at: string }>(
      `select id, updated_at::text as updated_at from public.grocery_list_items where list_id = $1 order by id`,
      [listId],
    );
    expect(after).toEqual(before);
  });

  it("is one transaction: a rebuild that fails halfway leaves the list as it was", async () => {
    const { seeded, listId } = await firstBuild();
    const before = await itemsOf(listId);
    await t.query(`delete from public.meal_plan_entries where id = $1`, [
      seeded.ids.of("entry:e-black-bean-tacos"),
    ]);

    const failing: SqlRunner = {
      query: (text, params) => t.runner.query(text, params),
      transaction: (fn) =>
        t.runner.transaction((tx) =>
          fn({
            ...tx,
            query: (text, params) => {
              if (/delete from public\.grocery_list_items/.test(text)) {
                return Promise.reject(new Error("connection lost"));
              }
              return tx.query(text, params);
            },
          }),
        ),
    };
    await expect(
      new SqlListStore(failing).build({
        householdId: seeded.householdId,
        weekStart: seeded.weekStart,
        now: new Date("2026-11-02T08:00:00.000Z"),
      }),
    ).rejects.toThrow("connection lost");

    expect(await itemsOf(listId)).toEqual(before);
    const lists = await t.query<{ plan_version: number }>(
      `select plan_version from public.grocery_lists where id = $1`,
      [listId],
    );
    expect(lists[0]?.plan_version).toBe(1);
  });

  it("builds one list when two phones ask for the same week", async () => {
    const seeded = await seedFixture(t, WEEK);
    const input = { householdId: seeded.householdId, weekStart: seeded.weekStart, now: NOW };
    const first = await store.build(input);
    const second = await store.build(input);
    expect(second.listId).toBe(first.listId);
    expect(second.planVersion).toBe(2);
    const lists = await t.query(`select 1 from public.grocery_lists`);
    expect(lists).toHaveLength(1);
  });

  it("carries the household's aisle order to the next week's list", async () => {
    const seeded = await seedFixture(t, WEEK);
    const first = await store.build({
      householdId: seeded.householdId,
      weekStart: seeded.weekStart,
      now: NOW,
    });
    await t.query(`update public.grocery_lists set section_order = $2::text[] where id = $1`, [
      first.listId,
      ["meat", "produce"],
    ]);
    // The same list rebuilt follows its own order.
    await store.build({ householdId: seeded.householdId, weekStart: seeded.weekStart, now: NOW });
    const rebuilt = await itemsOf(first.listId);
    expect(rebuilt[0]?.section).toBe("meat");

    // A new week starts from the order the household last chose.
    await t.query(
      `insert into public.meal_plans (id, household_id, week_start)
       values ('66666666-6666-4666-8666-666666666666', $1, '2026-11-09')`,
      [seeded.householdId],
    );
    const next = await store.build({
      householdId: seeded.householdId,
      weekStart: "2026-11-09",
      now: NOW,
    });
    const order = await t.query<{ section_order: string[] }>(
      `select section_order from public.grocery_lists where id = $1`,
      [next.listId],
    );
    expect(order[0]?.section_order).toEqual(["meat", "produce"]);
  });
});

describe("pantry (acceptance criterion 6)", () => {
  it("a have row takes an item off the next build, and out brings it back", async () => {
    const seeded = await seedFixture(t, WEEK);
    const input = { householdId: seeded.householdId, weekStart: seeded.weekStart, now: NOW };
    const cumin = (
      await t.query<{ id: string }>(`select id from public.ingredients where name = 'cumin'`)
    )[0]?.id;

    const first = await store.build(input);
    const cuminBefore = (await itemsOf(first.listId)).find((r) => r.display_name === "Cumin");
    expect(cuminBefore?.excluded_reason).toBeNull();

    await t.query(
      `insert into public.pantry_items (household_id, ingredient_id, status) values ($1, $2, 'have')`,
      [seeded.householdId, cumin],
    );
    const second = await store.build(input);
    const cuminHave = (await itemsOf(second.listId)).find((r) => r.display_name === "Cumin");
    expect(cuminHave).toMatchObject({ id: cuminBefore?.id, excluded_reason: "pantry" });
    expect(second.itemCount).toBe(first.itemCount - 1);
    expect(second.alreadyHaveCount).toBe(first.alreadyHaveCount + 1);

    await t.query(`update public.pantry_items set status = 'out' where ingredient_id = $1`, [
      cumin,
    ]);
    const third = await store.build(input);
    const cuminOut = (await itemsOf(third.listId)).find((r) => r.display_name === "Cumin");
    expect(cuminOut?.excluded_reason).toBeNull();
    expect(third.itemCount).toBe(first.itemCount);
  });

  it("a staple with no pantry row counts as have, and a row can say otherwise", async () => {
    const seeded = await seedFixture(t, WEEK);
    const input = { householdId: seeded.householdId, weekStart: seeded.weekStart, now: NOW };
    const first = await store.build(input);
    const water = (await itemsOf(first.listId)).find((r) => r.display_name === "Water");
    expect(water?.excluded_reason).toBe("pantry");
    const waterId = (
      await t.query<{ id: string }>(`select id from public.ingredients where name = 'water'`)
    )[0]?.id;
    await t.query(
      `insert into public.pantry_items (household_id, ingredient_id, status) values ($1, $2, 'out')`,
      [seeded.householdId, waterId],
    );
    const second = await store.build(input);
    expect(
      (await itemsOf(second.listId)).find((r) => r.display_name === "Water")?.excluded_reason,
    ).toBeNull();
  });
});

describe("the service role", () => {
  it("starts every transaction as service_role", async () => {
    const seeded = await seedFixture(t, WEEK);
    const firstStatements: string[] = [];
    const spy: SqlRunner = {
      query: (text, params) => t.runner.query(text, params),
      transaction: (fn) =>
        t.runner.transaction((tx) => {
          let first = true;
          return fn({
            ...tx,
            query: (text, params) => {
              if (first) firstStatements.push(text);
              first = false;
              return tx.query(text, params);
            },
          });
        }),
    };
    const spied = new SqlListStore(spy);
    await spied.resolveHousehold(seeded.userId);
    await spied.resolveHousehold(seeded.userId, seeded.householdId);
    await spied.build({ householdId: seeded.householdId, weekStart: seeded.weekStart, now: NOW });
    expect(firstStatements).toHaveLength(3);
    for (const statement of firstStatements) expect(statement).toBe(SERVICE_ROLE_STATEMENT);
  });

  it("cannot run DDL: a create table inside such a transaction fails", async () => {
    await expect(
      t.runner.transaction(async (tx) => {
        await tx.query(SERVICE_ROLE_STATEMENT, []);
        await tx.query("create table public.zz_ddl_probe (id int)", []);
      }),
    ).rejects.toThrow(/permission denied/);
    const tables = await t.query(`select 1 from pg_tables where tablename = 'zz_ddl_probe'`);
    expect(tables).toEqual([]);
  });

  it("cannot drop or alter the tables either, but can use them", async () => {
    await expect(
      t.runner.transaction(async (tx) => {
        await tx.query(SERVICE_ROLE_STATEMENT, []);
        await tx.query("drop table public.grocery_lists cascade", []);
      }),
    ).rejects.toThrow(/must be owner/);
    await expect(
      t.runner.transaction(async (tx) => {
        await tx.query(SERVICE_ROLE_STATEMENT, []);
        await tx.query("alter table public.grocery_list_items add column zz int", []);
      }),
    ).rejects.toThrow(/must be owner/);
    const rows = await t.runner.transaction(async (tx) => {
      await tx.query(SERVICE_ROLE_STATEMENT, []);
      return tx.query("select count(*)::int as n from public.grocery_lists", []);
    });
    expect(rows).toEqual([{ n: 0 }]);
  });
});

describe("resolveHousehold", () => {
  it("accepts a member's own household and refuses another", async () => {
    await insertHousehold(t, { userId: USER_ID, householdId: HOUSEHOLD_ID });
    const other = "0b000000-0000-4000-8000-00000000000b";
    await t.query(`insert into public.households (id, name) values ($1, 'Other')`, [other]);
    expect(await store.resolveHousehold(USER_ID, HOUSEHOLD_ID)).toEqual({
      kind: "member",
      householdId: HOUSEHOLD_ID,
    });
    expect(await store.resolveHousehold(USER_ID, other)).toEqual({ kind: "not_a_member" });
  });

  it("defaults to the household joined most recently", async () => {
    await insertHousehold(t, { userId: USER_ID, householdId: HOUSEHOLD_ID });
    const later = "0b000000-0000-4000-8000-00000000000b";
    await t.query(`insert into public.households (id, name) values ($1, 'Later')`, [later]);
    await t.query(
      `insert into public.household_members (household_id, user_id, role, created_at)
       values ($1, $2, 'member', now() + interval '1 day')`,
      [later, USER_ID],
    );
    expect(await store.resolveHousehold(USER_ID)).toEqual({ kind: "member", householdId: later });
  });

  it("knows a person with no household, and ignores a deleted one", async () => {
    await t.query(`insert into auth.users (id, email) values ($1, 'x@example.test')`, [USER_ID]);
    expect(await store.resolveHousehold(USER_ID)).toEqual({ kind: "no_household" });
    await insertHousehold(t, { userId: USER_ID, householdId: HOUSEHOLD_ID });
    await t.query(`update public.households set deleted_at = now()`);
    expect(await store.resolveHousehold(USER_ID)).toEqual({ kind: "no_household" });
    expect(await store.resolveHousehold(USER_ID, HOUSEHOLD_ID)).toEqual({ kind: "not_a_member" });
  });
});

describe("listNameFor", () => {
  it("names the list for its week", () => {
    expect(listNameFor("2026-11-02")).toBe("Week of Nov 2");
    expect(listNameFor("2026-12-28")).toBe("Week of Dec 28");
    expect(listNameFor("2027-01-04")).toBe("Week of Jan 4");
  });
});
