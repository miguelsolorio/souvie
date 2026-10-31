// How JSON parameters reach Postgres (WS05 follow-up, 2026-10-31).
//
// "Build grocery list" failed on the hosted project with `22023 cannot call jsonb_to_recordset on
// a non-array`, and every store test had passed. postgres.js asks Postgres for the type of each
// parameter and serializes the value for that type; for json and jsonb that is `JSON.stringify`,
// applied to strings too. The store had already stringified its rows, so Postgres received a JSON
// string scalar. PGlite hands a string through untouched, so the test database never saw it.
//
// The first block pins the test runner to the driver's behavior, so that mistake fails here. The
// second keeps the rule from coming back in any function. The real driver against a real Postgres
// is store.postgres.test.ts, which CI runs.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createListTestDb, POSTGRES_JS_SERIALIZERS, type TestDb } from "./testing/db.ts";

let t: TestDb;

beforeAll(async () => {
  t = await createListTestDb();
}, 120_000);

afterAll(async () => {
  await t.close();
});

const ROWS = [
  { id: 1, name: "onion" },
  { id: 2, name: "garlic" },
];
const ROWS_JSON = JSON.stringify(ROWS);
const records = (param: string) => `jsonb_to_recordset(${param}) as x(id int, name text)`;

describe("the test runner binds JSON the way postgres.js does", () => {
  it("uses the driver's serializer for json and jsonb, and only those", () => {
    expect(Object.keys(POSTGRES_JS_SERIALIZERS).sort()).toEqual(["114", "3802"]);
    expect(POSTGRES_JS_SERIALIZERS[3802]?.(ROWS_JSON)).toBe(JSON.stringify(ROWS_JSON));
    expect(POSTGRES_JS_SERIALIZERS[114]?.(ROWS)).toBe(ROWS_JSON);
  });

  it("encodes a string bound to a jsonb cast a second time", async () => {
    const [row] = await t.runner.query<{ kind: string; text: string }>(
      `select jsonb_typeof($1::jsonb) as kind, $1::jsonb #>> '{}' as text`,
      [ROWS_JSON],
    );
    // A JSON string scalar that spells the array, not the array.
    expect(row).toEqual({ kind: "string", text: ROWS_JSON });
  });

  it("is the hosted failure: the old binding of the item rows throws 22023", async () => {
    const old = t.runner.query(
      `select x.id from ${records("$1::jsonb")}`,
      [ROWS_JSON], // what store.ts passed: JSON.stringify(rows) under $1::jsonb
    );
    await expect(old).rejects.toMatchObject({
      code: "22023",
      message: "cannot call jsonb_to_recordset on a non-array",
    });
  });

  it("fails the same way inside a transaction, which is where the store runs", async () => {
    const old = t.runner.transaction((tx) =>
      tx.query(`select x.id from ${records("$1::jsonb")}`, [ROWS_JSON]),
    );
    await expect(old).rejects.toMatchObject({ code: "22023" });
  });

  it("takes the type from Postgres, not from the text: a jsonb column is enough", async () => {
    await t.exec(`create temp table json_probe (v jsonb)`);
    await t.runner.query(`insert into json_probe (v) values ($1)`, [ROWS_JSON]);
    const [row] = await t.query<{ kind: string }>(`select jsonb_typeof(v) as kind from json_probe`);
    expect(row?.kind).toBe("string");
  });

  it("encodes a JavaScript value once", async () => {
    const rows = await t.runner.query<{ id: number; name: string }>(
      `select x.id, x.name from ${records("$1::jsonb")} order by x.id`,
      [ROWS],
    );
    expect(rows).toEqual(ROWS);
  });

  it("keeps a string whole when it is bound as text and cast in SQL", async () => {
    const rows = await t.runner.query<{ id: number; name: string }>(
      `select x.id, x.name from ${records("$1::text::jsonb")} order by x.id`,
      [ROWS_JSON],
    );
    expect(rows).toEqual(ROWS);
    // The same through a transaction.
    const inTx = await t.runner.transaction((tx) =>
      tx.query<{ id: number }>(`select x.id from ${records("$1::text::jsonb")} order by x.id`, [
        ROWS_JSON,
      ]),
    );
    expect(inTx.map((r) => r.id)).toEqual([1, 2]);
  });

  it("leaves a null alone", async () => {
    const [row] = await t.runner.query<{ v: unknown }>(`select $1::jsonb as v`, [null]);
    expect(row?.v).toBeNull();
  });

  it("leaves direct test access with PGlite's own handling, for the PostgREST stand-in", async () => {
    const [row] = await t.query<{ kind: string }>(`select jsonb_typeof($1::jsonb) as kind`, [
      ROWS_JSON,
    ]);
    expect(row?.kind).toBe("array");
  });
});

// ---------------------------------------------------------------------------
// The rule, for every function
// ---------------------------------------------------------------------------

const FUNCTIONS_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** Production sources of every function: no tests, no test harness folders. */
function functionSources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "testing" || entry.name === "node_modules") continue;
      found.push(...functionSources(path));
    } else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

/** `$1::jsonb`, `$2::json`, `$3 :: jsonb`, but not `$1::text::jsonb`. */
const BARE_JSON_CAST = /\$\d+\s*::\s*jsonb?\b/g;

/** Source without block comments and line comments, so a comment can name the rule. */
function withoutComments(text: string): string {
  return text.replace(/(^|\s)\/\*[\s\S]*?\*\//g, "$1").replace(/(^|\s)\/\/.*$/gm, "$1");
}

describe("no function binds a parameter straight to a json cast", () => {
  const sources = functionSources(FUNCTIONS_DIR);

  it("looks at the function sources", () => {
    expect(sources.length).toBeGreaterThan(20);
    expect(sources.some((path) => path.endsWith(join("list-build", "store.ts")))).toBe(true);
  });

  it("finds none of `$n::json` or `$n::jsonb`; bind text and cast in SQL (`$n::text::jsonb`)", () => {
    const offenders = sources.flatMap((path) => {
      const text = withoutComments(readFileSync(path, "utf8"));
      return [...text.matchAll(BARE_JSON_CAST)].map(
        (m) => `${relative(FUNCTIONS_DIR, path)}: ${m[0]}`,
      );
    });
    expect(offenders).toEqual([]);
  });

  it("the pattern catches what it is meant to", () => {
    expect("jsonb_to_recordset($1::jsonb)".match(BARE_JSON_CAST)).toHaveLength(1);
    expect("where x = $12 :: json".match(BARE_JSON_CAST)).toHaveLength(1);
    expect("jsonb_to_recordset($1::text::jsonb)".match(BARE_JSON_CAST)).toBeNull();
    expect("'{}'::jsonb".match(BARE_JSON_CAST)).toBeNull();
    // Comments may name the rule; code may not break it.
    expect(
      withoutComments("// write $1::jsonb never\nconst a = 1;").match(BARE_JSON_CAST),
    ).toBeNull();
    expect(withoutComments("/* $1::jsonb */ x").match(BARE_JSON_CAST)).toBeNull();
    expect(withoutComments("select $1::jsonb // why").match(BARE_JSON_CAST)).toHaveLength(1);
  });
});
