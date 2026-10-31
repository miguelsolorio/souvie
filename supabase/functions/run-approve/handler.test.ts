// run-approve against the real migrations on PGlite: membership before any read, one
// transaction under service_role, the review applied with @mp/agent's applyReview, the budget
// cap, product_matches learned, needs_review -> running, and the dispatch message.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleRunApprove, type Runtime } from "./handler.ts";
import { SqlApproveStore } from "./store.ts";
import { createRunsTestDb, type RunsTestDb } from "./testing/db.ts";

const A = "0a000000-0000-4000-8000-0000000000aa";
const B = "0b000000-0000-4000-8000-0000000000bb";
const ALICE = "a1111111-1111-4111-8111-1111111111aa";
const BOB = "b2222222-2222-4222-8222-2222222222bb";
const LIST = "9a000000-0000-4000-8000-0000000000aa";
const CONN = "7a000000-0000-4000-8000-0000000000aa";
const RUN = "5a000000-0000-4000-8000-0000000000aa";
const ITEMS = [
  "6a000000-0000-4000-8000-000000000001",
  "6a000000-0000-4000-8000-000000000002",
  "6a000000-0000-4000-8000-000000000003",
];
const ING = [
  "11111111-0000-4000-8000-0000000000a1",
  "11111111-0000-4000-8000-0000000000a2",
  "11111111-0000-4000-8000-0000000000a3",
];
const GLI = [
  "8a000000-0000-4000-8000-000000000001",
  "8a000000-0000-4000-8000-000000000002",
  "8a000000-0000-4000-8000-000000000003",
];

let t: RunsTestDb;

beforeAll(async () => {
  t = await createRunsTestDb();
  await t.exec(`
    insert into auth.users (id, email) values ('${ALICE}', 'alice-ra@example.test'), ('${BOB}', 'bob-ra@example.test');
    insert into public.households (id, name, created_by) values ('${A}', 'A', '${ALICE}'), ('${B}', 'B', '${BOB}');
    insert into public.household_members (household_id, user_id, role) values ('${A}', '${ALICE}', 'owner'), ('${B}', '${BOB}', 'owner');
    insert into public.ingredients (id, name, category, default_unit) values
      ('${ING[0]}', 'ra milk', 'dairy', 'cup'), ('${ING[1]}', 'ra onion', 'produce', 'each'), ('${ING[2]}', 'ra salmon', 'seafood', 'lb');
    insert into public.grocery_lists (id, household_id, name) values ('${LIST}', '${A}', 'A week');
    insert into public.grocery_list_items (id, list_id, household_id, ingredient_id, display_name, qty, unit, section, position) values
      ('${GLI[0]}', '${LIST}', '${A}', '${ING[0]}', 'Milk', 1, 'gallon', 'dairy', 0),
      ('${GLI[1]}', '${LIST}', '${A}', '${ING[1]}', 'Onions', 3, 'each', 'produce', 1),
      ('${GLI[2]}', '${LIST}', '${A}', '${ING[2]}', 'Salmon', 1.5, 'lb', 'seafood', 2);
    insert into public.retailer_connections (id, household_id, user_id, retailer, auth_type, store_id, store_name, status)
      values ('${CONN}', '${A}', '${ALICE}', 'kroger', 'none', 'MOCK0001', 'Mock QFC Duvall', 'active');
  `);
}, 120_000);

afterAll(async () => {
  await t?.close();
});

/** A fresh run at needs_review with three proposed lines, before every test. */
beforeEach(async () => {
  await t.exec(`
    delete from public.product_matches where household_id = '${A}';
    delete from public.shopping_runs where id = '${RUN}';
    insert into public.shopping_runs (id, household_id, list_id, connection_id, retailer, store_id, store_name, status, policy, subtotal_usd)
      values ('${RUN}', '${A}', '${LIST}', '${CONN}', 'kroger', 'MOCK0001', 'Mock QFC Duvall', 'needs_review',
              public.shopping_run_default_policy() || '{"budget_cap_usd": 40}', 27.56);
    insert into public.shopping_run_items (id, run_id, household_id, list_item_id, position, display_name, section, product_id, upc, product_name, size, qty, unit_price_usd, line_total_usd, status, alternatives) values
      ('${ITEMS[0]}', '${RUN}', '${A}', '${GLI[0]}', 0, 'Milk', 'dairy', '0099020000001', '0099020000001', 'Northfork Creamery Whole Milk', '1 gal', 1, 4.29, 4.29, 'matched',
        '[{"product_id": "0099020000004", "upc": "0099020000004", "name": "Northfork Creamery Organic Whole Milk", "size": "1/2 gal", "price": 4.99, "qty": 2}]'),
      ('${ITEMS[1]}', '${RUN}', '${A}', '${GLI[1]}', 1, 'Onions', 'produce', '0099010000004', '0099010000004', 'Harbor Fields Yellow Onions', '3 lb bag', 1, 3.49, 3.49, 'matched', null),
      ('${ITEMS[2]}', '${RUN}', '${A}', '${GLI[2]}', 2, 'Salmon', 'seafood', '0099030000028', '0099030000028', 'Puget Butcher Co. Atlantic Salmon Fillet', '1 lb', 2, 9.89, 19.78, 'matched', null);
  `);
});

function runtime(userId: string | null): Runtime {
  return {
    authenticate: async () => (userId ? { userId } : null),
    store: new SqlApproveStore(t.runner),
  };
}

function post(body: unknown, auth = "Bearer token"): Request {
  return new Request("http://localhost/functions/v1/run-approve", {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function snapshot() {
  const run = await t.query(
    `select status, approved_at, approved_by, subtotal_usd, heartbeat_at from public.shopping_runs where id = $1`,
    [RUN],
  );
  const items = await t.query(
    `select id, status, product_id, qty, line_total_usd, user_decision, alternatives from public.shopping_run_items where run_id = $1 order by position`,
    [RUN],
  );
  const queue = await t.query(
    `select count(*)::int as n from pgmq.q_shopping_run where message ->> 'run_id' = $1`,
    [RUN],
  );
  const matches = await t.query(
    `select count(*)::int as n from public.product_matches where household_id = $1`,
    [A],
  );
  return { run, items, queue, matches };
}

describe("run-approve", () => {
  it("refuses a request with no signed-in user", async () => {
    const res = await handleRunApprove(post({ runId: RUN, decisions: [] }), runtime(null));
    expect(res.status).toBe(401);
  });

  it("refuses a body that is not a review", async () => {
    const res = await handleRunApprove(
      post({ runId: RUN, decisions: [{ runItemId: ITEMS[0], action: "buy_everything" }] }),
      runtime(ALICE),
    );
    expect(res.status).toBe(400);
  });

  it("answers 403 to another household's run and leaves every row as it was", async () => {
    const before = await snapshot();
    const res = await handleRunApprove(
      post({ runId: RUN, decisions: [{ runItemId: ITEMS[2], action: "remove" }] }),
      runtime(BOB),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: "not_a_member" });
    expect(await snapshot()).toEqual(before);
    // A run id that does not exist gets the same answer: no oracle.
    const missing = await handleRunApprove(
      post({ runId: "5a000000-0000-4000-8000-0000000000ff", decisions: [] }),
      runtime(BOB),
    );
    expect(missing.status).toBe(403);
  });

  it("applies the review, opens the push phase, learns the choices, and dispatches the run", async () => {
    const res = await handleRunApprove(
      post({
        runId: RUN,
        decisions: [
          { runItemId: ITEMS[0], action: "swap", alternativeIndex: 0 },
          { runItemId: ITEMS[2], action: "quantity", quantity: 1 },
        ],
      }),
      runtime(ALICE),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      runId: RUN,
      status: "running",
      subtotalUsd: 23.36,
      itemCount: 3,
    });

    const after = await snapshot();
    expect(after.run[0]).toMatchObject({
      status: "running",
      approved_by: ALICE,
      heartbeat_at: null,
    });
    expect(after.run[0]?.approved_at).not.toBeNull();
    expect(after.items.map((i) => [i.product_id, Number(i.qty), i.user_decision])).toEqual([
      ["0099020000004", 2, "swapped"],
      ["0099010000004", 1, "accepted"],
      ["0099030000028", 1, "accepted"],
    ]);
    expect(after.queue[0]?.n).toBe(1);
    const learned = await t.query<{ product_id: string; chosen_by: string; pinned: boolean }>(
      `select product_id, chosen_by::text as chosen_by, pinned from public.product_matches where household_id = $1 order by product_id`,
      [A],
    );
    expect(learned).toEqual([
      { product_id: "0099010000004", chosen_by: "agent", pinned: false },
      { product_id: "0099020000004", chosen_by: "user", pinned: false },
      { product_id: "0099030000028", chosen_by: "agent", pinned: false },
    ]);

    const again = await handleRunApprove(post({ runId: RUN, decisions: [] }), runtime(ALICE));
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: "not_reviewable" });
  });

  it("refuses a cart over the budget cap and writes nothing", async () => {
    const before = await snapshot();
    const res = await handleRunApprove(
      post({ runId: RUN, decisions: [{ runItemId: ITEMS[2], action: "quantity", quantity: 4 }] }),
      runtime(ALICE),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "over_budget" });
    expect(await snapshot()).toEqual(before);
  });

  it("refuses a swap to an alternative the line does not have, and an empty cart", async () => {
    const bad = await handleRunApprove(
      post({
        runId: RUN,
        decisions: [{ runItemId: ITEMS[1], action: "swap", alternativeIndex: 0 }],
      }),
      runtime(ALICE),
    );
    expect(bad.status).toBe(400);
    const empty = await handleRunApprove(
      post({ runId: RUN, decisions: ITEMS.map((id) => ({ runItemId: id, action: "remove" })) }),
      runtime(ALICE),
    );
    expect(empty.status).toBe(409);
    expect(await empty.json()).toMatchObject({ error: "empty_cart" });
  });

  it("runs as service_role, which cannot run DDL", async () => {
    await expect(
      t.runner.transaction(async (tx) => {
        await tx.query("set local role service_role", []);
        await tx.query("create table public.__ra_ddl (id int)", []);
      }),
    ).rejects.toThrow(/permission denied/);
  });
});
