// F1 (WS05 review): the pantry must be writable through the real API.
//
// PostgREST turns a merge upsert into `ON CONFLICT DO UPDATE SET <every payload column> =
// EXCLUDED.<column>`, and clients hold `update (status)` only, so the write the pantry screen made
// was refused. This test runs the client's own function (`writePantryStatus`, from @mp/db) against
// the fake supabase-js client, turns each request it made into the SQL PostgREST generates for it,
// and runs that SQL on PGlite as the `authenticated` role on the real migrations. A statement that
// the grants refuse fails here the way it fails in production.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ingredientNamed } from "../../../packages/core/src/list/fixtures/harness.ts";
import { writePantryStatus } from "../../../packages/db/src/lists.ts";
import { fakeClient, type RequestLog } from "../../../packages/db/src/testing/fakeClient.ts";
import { createListTestDb, type TestDb } from "./testing/db.ts";
import { insertHousehold, insertOntology } from "./testing/seed.ts";

const ALICE = "a1111111-1111-4111-8111-111111111111";
const HOUSE = "0a000000-0000-4000-8000-00000000000a";

let t: TestDb;
let cumin: string;

beforeEach(async () => {
  t = await createListTestDb();
  await insertHousehold(t, { userId: ALICE, householdId: HOUSE });
  await insertOntology(t);
  cumin = ingredientNamed("cumin").id;
}, 120_000);

afterEach(async () => {
  await t.close();
});

/** The SQL PostgREST generates for one supabase-js request (QueryBuilder.hs), with its parameters. */
function postgrestSql(entry: RequestLog): { sql: string; params: unknown[] } {
  const table = `public.${entry.table}`;
  const isList = Array.isArray(entry.payload);
  const populate = isList ? "json_populate_recordset" : "json_populate_record";
  const body = JSON.stringify(entry.payload);
  const columns = Object.keys((isList ? (entry.payload as object[])[0] : entry.payload) as object);
  const list = columns.map((c) => `"${c}"`).join(", ");
  const options = (entry.options ?? {}) as { onConflict?: string; ignoreDuplicates?: boolean };
  const where = entry.filters
    .filter(([, op]) => op === "eq")
    .map(([column], i) => `${table}."${column}" = $${i + 2}`)
    .join(" and ");
  const filterValues = entry.filters.map(([, , value]) => value);

  switch (entry.op) {
    case "upsert": {
      const conflict = (options.onConflict ?? "id")
        .split(",")
        .map((c) => `"${c.trim()}"`)
        .join(", ");
      const action = options.ignoreDuplicates
        ? "do nothing"
        : `do update set ${columns.map((c) => `"${c}" = excluded."${c}"`).join(", ")}`;
      return {
        sql: `insert into ${table} (${list}) select ${list} from ${populate}(null::${table}, $1::json) on conflict (${conflict}) ${action}`,
        params: [body],
      };
    }
    case "update":
      // PostgREST (v11 and later) selects the payload columns from the populated record and
      // qualifies the filter columns with the table, so neither is ambiguous.
      return {
        sql: `update ${table} set ${columns.map((c) => `"${c}" = pgrst_body."${c}"`).join(", ")} from (select ${list} from ${populate}(null::${table}, $1::json) as _) pgrst_body where ${where}`,
        params: [body, ...filterValues],
      };
    default:
      throw new Error(`no SQL for ${entry.op}`);
  }
}

/** Runs one statement as a signed-in member, rolling back on error. Returns the error text or null. */
async function asMember(userId: string, sql: string, params: unknown[]): Promise<string | null> {
  await t.exec("begin");
  try {
    await t.exec(
      `select set_config('request.jwt.claims', '{"sub": "${userId}", "role": "authenticated"}', true)`,
    );
    await t.exec("set local role authenticated");
    await t.query(sql, params);
    await t.exec("commit");
    return null;
  } catch (error) {
    await t.exec("rollback");
    return (error as Error).message;
  }
}

/** Every request the client made since `from`, run as `userId`. Returns the errors, if any. */
async function replay(server: { log: RequestLog[] }, from: number, userId = ALICE) {
  const errors: string[] = [];
  for (const entry of server.log.slice(from)) {
    const { sql, params } = postgrestSql(entry);
    const error = await asMember(userId, sql, params);
    if (error) errors.push(`${entry.op} ${entry.table}: ${error}`);
  }
  return errors;
}

const pantryRows = () =>
  t.query<{ status: string }>(
    "select status::text as status from public.pantry_items where household_id = $1 and ingredient_id = $2",
    [HOUSE, cumin],
  );

describe("the pantry through the real API (F1)", () => {
  it("a first write and a change of an existing row are both accepted", async () => {
    const { client, server } = fakeClient();

    let mark = server.log.length;
    await writePantryStatus(client, { householdId: HOUSE, ingredientId: cumin, status: "have" });
    expect(await replay(server, mark)).toEqual([]);
    expect(await pantryRows()).toEqual([{ status: "have" }]);

    mark = server.log.length;
    await writePantryStatus(client, { householdId: HOUSE, ingredientId: cumin, status: "out" });
    expect(await replay(server, mark)).toEqual([]);
    expect(await pantryRows()).toEqual([{ status: "out" }]);

    mark = server.log.length;
    await writePantryStatus(client, { householdId: HOUSE, ingredientId: cumin, status: "low" });
    expect(await replay(server, mark)).toEqual([]);
    expect(await pantryRows()).toEqual([{ status: "low" }]);
  });

  it("never asks the database to rewrite the key columns", async () => {
    const { client, server } = fakeClient();
    await writePantryStatus(client, { householdId: HOUSE, ingredientId: cumin, status: "have" });
    for (const entry of server.log) {
      const { sql } = postgrestSql(entry);
      expect(sql).not.toMatch(/do update/);
      if (entry.op === "update") {
        expect(Object.keys(entry.payload as object)).toEqual(["status"]);
      }
    }
  });

  it("the merge upsert is what the grants refuse, which is why the client does not send it", async () => {
    const merge = postgrestSql({
      table: "pantry_items",
      op: "upsert",
      payload: { household_id: HOUSE, ingredient_id: cumin, status: "out" },
      options: { onConflict: "household_id,ingredient_id" },
      filters: [],
      failed: false,
    });
    // Refused even for a first write: DO UPDATE needs the privilege whether or not a row conflicts.
    expect(await asMember(ALICE, merge.sql, merge.params)).toMatch(/permission denied/);
    expect(await pantryRows()).toEqual([]);
  });

  it("a member cannot write the pantry of a household they are not in", async () => {
    const { client, server } = fakeClient();
    await writePantryStatus(client, {
      householdId: "0b000000-0000-4000-8000-00000000000b",
      ingredientId: cumin,
      status: "have",
    });
    const errors = await replay(server, 0);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/row-level security/);
  });
});
