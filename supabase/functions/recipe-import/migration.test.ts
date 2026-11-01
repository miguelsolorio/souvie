// The recipes_source_url_normalized migration (WS02 follow-up) on a real Postgres with no
// container: PGlite, through the harness WS05 built for list-build (../list-build/testing). CI runs
// the same migration and the same pgTAP file on the Supabase stack; this gives the same answer
// before a push, and adds two checks pgTAP cannot make:
//   * the SQL function agrees with normalizeSourceUrl on one shared list of links, and
//   * the backfill copes with a household that already holds the same link twice.
// The harness applies the repo's migrations up to the lists migration. This file applies the one
// under test itself, after seeding old data, the way a deploy would meet it.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LINK_CASES } from "../../../packages/recipe-import/src/dedupe.fixtures.ts";
import { normalizeSourceUrl } from "../../../packages/recipe-import/src/dedupe.ts";
import { createListTestDb, TESTS_DIR, type TestDb } from "../list-build/testing/db.ts";
import { runPgTapFile } from "../list-build/testing/pgtap.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, "..", "..", "migrations");

const MIGRATION = readdirSync(MIGRATIONS_DIR).find((file) =>
  /^\d+_recipes_source_url_normalized\.sql$/.test(file),
);

const OWNER = "5a000000-0000-4000-8000-0000000000a1";
const HOUSEHOLD_A = "5a000000-0000-4000-8000-00000000000a";
const HOUSEHOLD_B = "5a000000-0000-4000-8000-00000000000b";
const id = (n: number) => `5e000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

let t: TestDb;

beforeAll(async () => {
  if (!MIGRATION) throw new Error("the recipes_source_url_normalized migration is missing");
  t = await createListTestDb({ pgtap: true });

  // Data that exists before the migration: the same link twice in one household (nothing stopped
  // it), a deleted copy, the same link in another household, a typed recipe, and a catalog row.
  await t.exec(`
    insert into auth.users (id, email, raw_user_meta_data) values ('${OWNER}', 'owner@example.test', '{}');
    insert into public.households (id, name, created_by) values
      ('${HOUSEHOLD_A}', 'A', '${OWNER}'), ('${HOUSEHOLD_B}', 'B', '${OWNER}');
    insert into public.recipes (id, household_id, title, source_type, source_url, visibility, created_at, updated_at, deleted_at) values
      ('${id(1)}', '${HOUSEHOLD_A}', 'Older live copy', 'url', 'https://example.test/dup', 'household', '2026-10-01', '2026-10-02', null),
      ('${id(2)}', '${HOUSEHOLD_A}', 'Newer live copy', 'url', 'https://Example.test/dup/?utm_source=mail', 'household', '2026-10-05', '2026-10-06', null),
      ('${id(3)}', '${HOUSEHOLD_A}', 'Deleted copy', 'url', 'https://example.test/dup#top', 'household', '2026-09-01', '2026-09-02', '2026-09-03'),
      ('${id(4)}', '${HOUSEHOLD_B}', 'Other household', 'url', 'https://example.test/dup', 'household', '2026-10-03', '2026-10-04', null),
      ('${id(5)}', '${HOUSEHOLD_A}', 'Typed', 'manual', null, 'household', '2026-10-07', '2026-10-08', null),
      ('${id(6)}', null, 'Catalog', 'ai', 'https://catalog.example.test/a', 'catalog', '2026-10-09', '2026-10-10', null),
      ('${id(7)}', '${HOUSEHOLD_A}', 'Solo', 'url', 'https://example.test/solo/', 'household', '2026-10-11', '2026-10-12', null);
  `);

  await t.exec(readFileSync(join(MIGRATIONS_DIR, MIGRATION), "utf8"));
}, 120_000);

afterAll(async () => {
  await t?.close();
});

async function keyOf(recipeId: string): Promise<string | null> {
  const rows = await t.query<{ k: string | null }>(
    "select source_url_normalized as k from public.recipes where id = $1",
    [recipeId],
  );
  return rows[0]?.k ?? null;
}

describe("the backfill", () => {
  it("lets the oldest live copy of a link take the key and leaves the other live copy unkeyed", async () => {
    expect(await keyOf(id(1))).toBe("https://example.test/dup");
    expect(await keyOf(id(2))).toBeNull();
  });

  it("deletes nothing and keys the rows the index does not cover", async () => {
    const all = await t.query<{ n: number }>(
      "select count(*)::int as n from public.recipes where id::text like '5e000000-%'",
    );
    expect(all[0]?.n).toBe(7);
    expect(await keyOf(id(3))).toBe("https://example.test/dup"); // soft-deleted
    expect(await keyOf(id(4))).toBe("https://example.test/dup"); // another household
    expect(await keyOf(id(5))).toBeNull(); // no link
    expect(await keyOf(id(6))).toBe("https://catalog.example.test/a"); // catalog
    expect(await keyOf(id(7))).toBe("https://example.test/solo");
  });

  it("leaves updated_at alone", async () => {
    const rows = await t.query<{ id: string; updated_at: string }>(
      "select id, updated_at::text as updated_at from public.recipes where id::text like '5e000000-%' order by id",
    );
    expect(rows.map((r) => r.updated_at.slice(0, 10))).toEqual([
      "2026-10-02",
      "2026-10-06",
      "2026-09-02",
      "2026-10-04",
      "2026-10-08",
      "2026-10-10",
      "2026-10-12",
    ]);
  });

  it("builds the unique index despite the old duplicate, and the index then protects the household", async () => {
    await expect(
      t.exec(
        `insert into public.recipes (household_id, title, source_type, source_url) values ('${HOUSEHOLD_A}', 'Third', 'url', 'https://example.test/dup/')`,
      ),
    ).rejects.toThrow(/recipes_household_source_url_normalized_uq/);
    // The unkeyed old copy is untouched and still live.
    const live = await t.query<{ n: number }>(
      `select count(*)::int as n from public.recipes where household_id = '${HOUSEHOLD_A}' and deleted_at is null and source_url like '%/dup%'`,
    );
    expect(live[0]?.n).toBe(2);
  });
});

describe("normalize_source_url and normalizeSourceUrl", () => {
  it("agree on every link in the shared list, and on what it should be", async () => {
    for (const [input, expected] of LINK_CASES) {
      const rows = await t.query<{ n: string | null }>(
        "select public.normalize_source_url($1) as n",
        [input],
      );
      expect({ input, sql: rows[0]?.n ?? null, ts: normalizeSourceUrl(input) }).toEqual({
        input,
        sql: expected,
        ts: expected,
      });
    }
  });
});

describe("supabase/tests/ws02b_recipes_dedupe.sql", () => {
  it("passes under the pgTAP shim", async () => {
    const report = await runPgTapFile(t, join(TESTS_DIR, "ws02b_recipes_dedupe.sql"));
    expect(report.failures).toEqual([]);
    expect(report.summary).toEqual([]);
    expect(report.ran).toBe(report.planned);
    expect(report.ran).toBeGreaterThanOrEqual(30);
  }, 120_000);

  it("changes none of the data the backfill produced (the file rolls back)", async () => {
    expect(await keyOf(id(1))).toBe("https://example.test/dup");
  });
});
