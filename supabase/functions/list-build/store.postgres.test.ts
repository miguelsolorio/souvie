// The store on a real Postgres, through the real driver (WS05 follow-up, 2026-10-31).
//
// store.test.ts runs the same SQL on PGlite, with a runner that binds JSON the way postgres.js
// does (testing/db.ts). That is a model of the driver, and the first version of it was wrong: it
// passed a string through a jsonb parameter that postgres.js encodes a second time, so "Build
// grocery list" failed on the hosted project with 22023 while every test passed. This file takes
// the model out of the loop. It connects with postgres.js, configured as client.ts configures it
// for the function (`prepare: false`), to a real database, and runs the five-dinner build and a
// rebuild through the function's own adapter (sql.ts runnerOf) and store.
//
// It runs only when LIST_BUILD_TEST_DATABASE_URL is set, so `pnpm test` stays container-free. CI's
// `supabase` job sets it to the local stack's database after `db reset`. To run it by hand, point
// it at any database that has the repo's migrations and the ontology seed, for example
// `supabase start` then `supabase db reset`:
//
//   LIST_BUILD_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
//     pnpm exec vitest run --project unit supabase/functions/list-build/store.postgres.test.ts
//
// The test writes one household and one user of its own (fixed ids), removes them before and after
// it runs, and never reads or changes anything else. The URL is read from the environment only.
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildList,
  type Ingredient,
  type ListEntry,
  planFingerprint,
} from "../../../packages/core/src/index.ts";
import { inputOf, type ListFixture } from "../../../packages/core/src/list/fixtures/harness.ts";
import { FIXTURES } from "../../../packages/core/src/list/fixtures/index.ts";
import { type PgClient, runnerOf, type SqlRunner } from "./sql.ts";
import { SqlListStore } from "./store.ts";
import { HOUSEHOLD_ID, type Queryable, seedFixture, USER_ID } from "./testing/seed.ts";

// biome-ignore lint/suspicious/noUndeclaredEnvVars: a switch for this test, not an input of a turbo task
const DATABASE_URL = process.env.LIST_BUILD_TEST_DATABASE_URL;

const WEEK = FIXTURES["week-of-five-dinners"] as ListFixture;
const FIRST_BUILD = new Date("2026-11-01T18:00:00.000Z");
const SECOND_BUILD = new Date("2026-11-02T08:00:00.000Z");

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
  source_entry_ids: string[];
  detail: { contributions: unknown[] };
}

describe.skipIf(!DATABASE_URL)("list-build store on a real Postgres, through postgres.js", () => {
  let pg: ReturnType<typeof postgres>;
  let runner: SqlRunner;
  let store: SqlListStore;
  let db: Queryable;

  const itemsOf = (listId: string) =>
    db.query<ItemRow>(
      `select id, ingredient_id, display_name, qty::float8 as qty, unit, section, checked,
              checked_by, excluded_reason::text as excluded_reason, needs_attention, is_manual,
              position, source_entry_ids, detail
         from public.grocery_list_items where list_id = $1::uuid order by position, id`,
      [listId],
    );

  /** The ingredient rows as the database has them, so a later edit of the seed cannot fail this. */
  async function ingredientsOf(ids: readonly string[]): Promise<Map<string, Ingredient>> {
    const rows = await db.query<Ingredient>(
      `select id, name, plural, category::text as category, default_unit as "defaultUnit",
              density_g_per_ml::float8 as "densityGPerMl",
              typical_unit_weight_g::float8 as "typicalUnitWeightG",
              usda_fdc_id as "usdaFdcId", is_staple_default as "isStapleDefault"
         from public.ingredients where id = any($1::uuid[])`,
      [ids],
    );
    return new Map(rows.map((row) => [row.id, row]));
  }

  async function removeTestData(): Promise<void> {
    // The household first: its recipes, plan, lists and items go with it.
    await db.query(`delete from public.households where id = $1::uuid`, [HOUSEHOLD_ID]);
    await db.query(`delete from auth.users where id = $1::uuid`, [USER_ID]);
  }

  let seeded: Awaited<ReturnType<typeof seedFixture>>;
  let listId = "";
  let firstItems: ItemRow[] = [];

  beforeAll(async () => {
    // The options client.ts gives the function's pool, with one connection: the tests run one after
    // another.
    pg = postgres(DATABASE_URL ?? "", {
      prepare: false,
      max: 1,
      idle_timeout: 20,
      connect_timeout: 10,
    });
    runner = runnerOf(pg as unknown as PgClient);
    store = new SqlListStore(runner);
    db = {
      query: async <T>(text: string, params: readonly unknown[] = []) =>
        (await runner.query(text, params)) as T[],
    };
    await removeTestData();
    seeded = await seedFixture(db, WEEK);
  }, 60_000);

  afterAll(async () => {
    try {
      if (db) await removeTestData();
    } finally {
      await pg?.end({ timeout: 5 });
    }
  }, 60_000);

  it("binds the item rows so Postgres reads an array (the hosted failure)", async () => {
    const rows = JSON.stringify([{ id: 1 }, { id: 2 }]);
    const records = (param: string) => `select x.id from jsonb_to_recordset(${param}) as x(id int)`;

    // What the store used to send: a string under a jsonb cast. postgres.js encodes it again.
    await expect(runner.query(records("$1::jsonb"), [rows])).rejects.toMatchObject({
      code: "22023",
      message: "cannot call jsonb_to_recordset on a non-array",
    });
    // What it sends now: text, cast in SQL.
    expect(await runner.query(records("$1::text::jsonb"), [rows])).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("builds the week of five dinners", async () => {
    const started = Date.now();
    const result = await store.build({
      householdId: seeded.householdId,
      weekStart: seeded.weekStart,
      now: FIRST_BUILD,
    });
    const elapsed = Date.now() - started;
    listId = result.listId;
    console.info(
      `list-build store.build on Postgres: ${elapsed} ms for ${WEEK.entries.length} dinners`,
    );
    expect(elapsed).toBeLessThan(2000);

    const input = inputOf(WEEK, seeded.ids);
    const ingredientIds = new Set(
      input.recipes.flatMap((r) => r.ingredients.map((l) => l.ingredient_id)),
    );
    const draft = buildList({
      ...input,
      ingredients: await ingredientsOf(
        [...ingredientIds].filter((id): id is string => id !== null),
      ),
    });

    expect(result).toMatchObject({
      ok: true,
      rebuilt: false,
      planVersion: 1,
      skippedEntryCount: 0,
    });
    expect(result.itemCount).toBe(draft.items.filter((item) => !item.excludedReason).length);
    expect(result.alreadyHaveCount).toBe(draft.items.filter((item) => item.excludedReason).length);
    const unplaced = WEEK.recipes.flatMap((r) => r.lines).filter((l) => l.ingredient === null);
    expect(result.needsAttentionCount).toBe(unplaced.length);

    firstItems = await itemsOf(listId);
    expect(firstItems.length).toBeGreaterThan(20);
    expect(firstItems).toHaveLength(draft.items.length);
    for (const [index, item] of draft.items.entries()) {
      const row = firstItems[index];
      expect(row?.display_name, `item ${index}`).toBe(item.displayName);
      expect(row?.qty).toBe(item.qty);
      expect(row?.unit).toBe(item.unit);
      expect(row?.section).toBe(item.section);
      expect(row?.excluded_reason).toBe(item.excludedReason ?? null);
      expect(row?.needs_attention).toBe(item.needsAttention);
      expect(row?.source_entry_ids).toEqual(item.sourceEntryIds);
      // `detail` is a jsonb object, not a JSON string holding one.
      expect(typeof row?.detail).toBe("object");
      expect(row?.detail.contributions).toHaveLength(item.contributions.length);
      expect(row?.checked).toBe(false);
      expect(row?.is_manual).toBe(false);
    }

    const lists = await db.query<{ plan_version: number; plan_fingerprint: string }>(
      `select plan_version, plan_fingerprint from public.grocery_lists where id = $1::uuid`,
      [listId],
    );
    expect(lists).toEqual([{ plan_version: 1, plan_fingerprint: planFingerprint(input.entries) }]);
  });

  it("rebuilds after the plan changes, keeping check-offs and manual items", async () => {
    expect(listId, "the first build above must have written the list").not.toBe("");
    const byName = (name: string, rows: ItemRow[]) => rows.find((r) => r.display_name === name);
    const chicken = byName("Chicken breast", firstItems);
    const lemon = byName("Lemon", firstItems);
    const broccoli = byName("Broccoli", firstItems);
    const tortilla = byName("Corn tortilla", firstItems);
    if (!chicken || !lemon || !broccoli || !tortilla) throw new Error("fixture changed");

    // What people did on the first list.
    await db.query(
      `update public.grocery_list_items
          set checked = true, checked_by = $2::uuid, checked_at = '2026-11-01 17:00:00+00'
        where id = any($1::uuid[])`,
      [[chicken.id, lemon.id], USER_ID],
    );
    await db.query(
      `insert into public.grocery_list_items
         (list_id, household_id, display_name, qty, section, is_manual, position)
       values ($1::uuid, $2::uuid, 'Paper towels', 2, 'household', true, 5000)`,
      [listId, seeded.householdId],
    );

    // The plan changes: the stir fry is cooked for eight, and the tacos are dropped. Amounts that
    // change are the rows the update statement writes; the tacos' own ingredients are deleted.
    const beef = seeded.ids.of("entry:e-beef-and-broccoli-stir-fry");
    const tacos = seeded.ids.of("entry:e-black-bean-tacos");
    await db.query(`update public.meal_plan_entries set servings = 8 where id = $1::uuid`, [beef]);
    await db.query(`delete from public.meal_plan_entries where id = $1::uuid`, [tacos]);

    const result = await store.build({
      householdId: seeded.householdId,
      weekStart: seeded.weekStart,
      now: SECOND_BUILD,
    });
    expect(result).toMatchObject({ listId, rebuilt: true, planVersion: 2 });

    const input = inputOf(WEEK, seeded.ids);
    const entries: ListEntry[] = input.entries
      .filter((entry) => entry.id !== tacos)
      .map((entry) => (entry.id === beef ? { ...entry, servings: 8 } : entry));
    const ingredientIds = new Set(
      input.recipes.flatMap((r) => r.ingredients.map((l) => l.ingredient_id)),
    );
    const draft = buildList({
      ...input,
      entries,
      ingredients: await ingredientsOf(
        [...ingredientIds].filter((id): id is string => id !== null),
      ),
    });

    const after = await itemsOf(listId);
    expect(new Set(after.map((r) => r.id)).size).toBe(after.length);
    const shape = (
      rows: { display_name: string; qty: number | null; unit: string | null; section: string }[],
    ) => rows.map((r) => `${r.section}|${r.display_name}|${r.qty}|${r.unit}`).sort();
    expect(shape(after.filter((r) => !r.is_manual))).toEqual(
      shape(
        draft.items.map((i) => ({
          display_name: i.displayName,
          qty: i.qty,
          unit: i.unit,
          section: i.section,
        })),
      ),
    );

    // The update statement ran: the stir fry's broccoli doubled, on the same row.
    const broccoliAfter = byName("Broccoli", after);
    expect(broccoliAfter?.id).toBe(broccoli.id);
    expect(broccoliAfter?.qty).toBe((broccoli.qty ?? 0) * 2);
    // The delete statement ran: the tacos' tortillas are gone.
    expect(byName("Corn tortilla", after)).toBeUndefined();
    // Check-offs survive on ingredients that are still planned, same row, same checker.
    expect(byName("Chicken breast", after)).toMatchObject({
      id: chicken.id,
      checked: true,
      checked_by: USER_ID,
    });
    expect(byName("Lemon", after)).toMatchObject({ id: lemon.id, checked: true });
    // The manual item is untouched.
    expect(byName("Paper towels", after)).toMatchObject({ is_manual: true, qty: 2 });

    const lists = await db.query<{ plan_version: number; plan_fingerprint: string }>(
      `select plan_version, plan_fingerprint from public.grocery_lists where id = $1::uuid`,
      [listId],
    );
    expect(lists).toEqual([{ plan_version: 2, plan_fingerprint: planFingerprint(entries) }]);
  });

  it("is unchanged by a third build when the plan did not change", async () => {
    expect(listId, "the first build above must have written the list").not.toBe("");
    const before = await db.query<{ id: string; updated_at: string }>(
      `select id, updated_at::text as updated_at from public.grocery_list_items
        where list_id = $1::uuid order by id`,
      [listId],
    );
    const result = await store.build({
      householdId: seeded.householdId,
      weekStart: seeded.weekStart,
      now: new Date("2026-11-02T09:00:00.000Z"),
    });
    expect(result).toMatchObject({ listId, rebuilt: true, planVersion: 3 });
    const after = await db.query<{ id: string; updated_at: string }>(
      `select id, updated_at::text as updated_at from public.grocery_list_items
        where list_id = $1::uuid order by id`,
      [listId],
    );
    expect(after).toEqual(before);
  });
});
