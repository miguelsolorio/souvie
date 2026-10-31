// The handler on the real store and the real migrations (PGlite), for the question the fake-store
// tests in handler.test.ts cannot answer: can a caller who names a household they are not in change
// anything there? (Lifted from the WS05 review, F5.)
//
// What this does not test: two builds racing on separate connections. PGlite is one connection, so
// the advisory lock is checked only by where it sits in the transaction (first, before any plan
// read) and by two builds in a row making one list; see the README.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ListFixture } from "../../../packages/core/src/list/fixtures/harness.ts";
import { FIXTURES } from "../../../packages/core/src/list/fixtures/index.ts";
import { handleListBuild, type Runtime } from "./handler.ts";
import type { SqlRunner } from "./sql.ts";
import { SqlListStore } from "./store.ts";
import { createListTestDb, type TestDb } from "./testing/db.ts";
import { insertHousehold, seedFixture } from "./testing/seed.ts";

const ALICE = "a1111111-1111-4111-8111-111111111111";
const BOB = "b2222222-2222-4222-8222-222222222222";
const HOUSE_A = "0a000000-0000-4000-8000-00000000000a";
const HOUSE_B = "0b000000-0000-4000-8000-00000000000b";
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

function runtimeFor(userId: string): Runtime {
  return { authenticate: async () => ({ userId }), store, now: () => NOW };
}

function post(body: unknown): Request {
  return new Request("http://localhost/functions/v1/list-build", {
    method: "POST",
    headers: { Authorization: "Bearer x", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Every list and item row with its timestamps, so "nothing changed" can be an equality. */
async function snapshot() {
  return {
    lists: await t.query(
      `select id, household_id, plan_id, plan_version, built_at::text as built_at,
              updated_at::text as updated_at from public.grocery_lists order by id`,
    ),
    items: await t.query(
      `select id, household_id, display_name, qty::text as qty, checked,
              updated_at::text as updated_at from public.grocery_list_items order by id`,
    ),
  };
}

describe("naming a household the caller is not in", () => {
  it("is refused for Bob's household and for one that does not exist, and changes no row", async () => {
    const week = FIXTURES["week-of-five-dinners"] as ListFixture;
    // Alice: a household with an empty plan for the week. Bob: the full week of five dinners.
    await insertHousehold(t, { userId: ALICE, householdId: HOUSE_A });
    await t.query(
      `insert into public.meal_plans (household_id, week_start) values ($1, '2026-11-02')`,
      [HOUSE_A],
    );
    const bob = await seedFixture(t, week, { userId: BOB, householdId: HOUSE_B });

    const bobBuild = await handleListBuild(post({ weekStart: bob.weekStart }), runtimeFor(BOB));
    expect(bobBuild.status).toBe(200);
    const before = await snapshot();
    expect(before.lists).toHaveLength(1);
    expect(before.items.length).toBeGreaterThan(0);

    // Alice names Bob's household (a build, then a rebuild attempt), then a made-up household.
    for (const householdId of [HOUSE_B, HOUSE_B, "0c000000-0000-4000-8000-00000000000c"]) {
      const response = await handleListBuild(
        post({ weekStart: bob.weekStart, householdId }),
        runtimeFor(ALICE),
      );
      expect(response.status).toBe(403);
      expect(((await response.json()) as { error: string }).error).toBe("not_a_member");
    }
    expect(await snapshot()).toEqual(before);

    // Without a household id she builds in her own household only, and Bob's rows are untouched.
    const own = await handleListBuild(post({ weekStart: "2026-11-02" }), runtimeFor(ALICE));
    expect(own.status).toBe(200);
    const after = await snapshot();
    const households = after.lists.map((l) => (l as { household_id: string }).household_id).sort();
    expect(households).toEqual([HOUSE_A, HOUSE_B]);
    expect(
      after.items.filter((i) => (i as { household_id: string }).household_id === HOUSE_B),
    ).toEqual(before.items);
  });

  it("is refused for a household the caller left", async () => {
    const week = FIXTURES["week-of-five-dinners"] as ListFixture;
    const alice = await seedFixture(t, week, { userId: ALICE, householdId: HOUSE_A });
    await t.query(`delete from public.household_members where user_id = $1`, [ALICE]);
    const response = await handleListBuild(
      post({ weekStart: alice.weekStart, householdId: HOUSE_A }),
      runtimeFor(ALICE),
    );
    expect(response.status).toBe(403);
    expect(await t.query(`select 1 from public.grocery_lists`)).toEqual([]);
  });

  it("is refused for a household that was deleted", async () => {
    const week = FIXTURES["week-of-five-dinners"] as ListFixture;
    const alice = await seedFixture(t, week, { userId: ALICE, householdId: HOUSE_A });
    await t.query(`update public.households set deleted_at = now()`);
    const response = await handleListBuild(
      post({ weekStart: alice.weekStart, householdId: HOUSE_A }),
      runtimeFor(ALICE),
    );
    expect(response.status).toBe(403);
    expect(await t.query(`select 1 from public.grocery_lists`)).toEqual([]);
  });
});

describe("the advisory lock", () => {
  it("is the first statement after the role switch, before any plan is read", async () => {
    const week = FIXTURES["week-of-five-dinners"] as ListFixture;
    const alice = await seedFixture(t, week, { userId: ALICE, householdId: HOUSE_A });
    const seen: string[] = [];
    const spy: SqlRunner = {
      query: (text, params) => t.runner.query(text, params),
      transaction: (fn) =>
        t.runner.transaction((tx) =>
          fn({
            ...tx,
            query: (text, params) => {
              seen.push(text.replace(/\s+/g, " ").trim().slice(0, 60));
              return tx.query(text, params);
            },
          }),
        ),
    };
    await new SqlListStore(spy).build({
      householdId: HOUSE_A,
      weekStart: alice.weekStart,
      now: NOW,
    });
    expect(seen[0]).toBe("set local role service_role");
    expect(seen[1]).toContain("pg_advisory_xact_lock");
    expect(seen[2]).toContain("select id from public.meal_plans");
  });
});
