// Test harness only (WS05): a real Postgres for list-build's SQL and for the lists migration's
// policies and triggers, with no container. PGlite is Postgres compiled to WASM; it runs our
// migrations unchanged. Three stand-ins matter:
//   * the version: PGlite 0.5 is Postgres 18, the hosted project and CI run Postgres 17. The SQL
//     here is plain and stable across both.
//   * the platform: Supabase's auth and storage schemas and API roles come from the stubs file the
//     suggest harness already ships (../../suggest/testing/supabase-stubs.sql), read from there so
//     there is one copy.
//   * the driver: the function talks to Postgres through postgres.js, and PGlite binds JSON
//     parameters differently. The runner closes that gap, see POSTGRES_JS_SERIALIZERS. The
//     real driver on a real Postgres is tested in store.postgres.test.ts (CI only).
// The migrations are the repo's own files, loaded below. Nothing is copied.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite, type QueryOptions } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { vector } from "@electric-sql/pglite-pgvector";
import type { SqlRunner } from "../sql.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FUNCTIONS_DIR = join(HERE, "..", "..");
const MIGRATIONS_DIR = join(FUNCTIONS_DIR, "..", "migrations");
export const STUBS_FILE = join(FUNCTIONS_DIR, "suggest", "testing", "supabase-stubs.sql");
export const SHIM_FILE = join(HERE, "pgtap-shim.sql");
export const TESTS_DIR = join(FUNCTIONS_DIR, "..", "tests");

/** The migrations the harness applies, in order, by name (the timestamp prefix is ignored). */
export const HARNESS_MIGRATIONS = [
  "identity",
  "identity_functions",
  "ingredients",
  "proposals_household_fk",
  "recipes",
  "planning",
  "recipes_catalog_read",
  "recipe_ingredients_container",
  "lists",
] as const;

function migrationFile(name: string): string | null {
  const match = readdirSync(MIGRATIONS_DIR).find((file) =>
    new RegExp(`^\\d+_${name}\\.sql$`).test(file),
  );
  return match ? join(MIGRATIONS_DIR, match) : null;
}

/**
 * How postgres.js (the driver list-build runs on, see client.ts) binds a parameter that Postgres
 * types as json or jsonb. It sends the statement unprepared, asks Postgres for the parameter types,
 * and serializes each value with the serializer for the type Postgres reported. For json (114) and
 * jsonb (3802) that serializer is `JSON.stringify`, applied to every value, strings included. So a
 * string bound to `$1::jsonb` is encoded a second time and Postgres receives a JSON string scalar,
 * not the array or object the string spells. That is what failed on the hosted project.
 *
 * PGlite's own serializer for these types passes a string through untouched, which let the old
 * binding pass every test. The runner below hands PGlite these serializers per query, so the type
 * still comes from Postgres (PGlite's own Describe step) and the encoding is the driver's. The
 * rule for code under test: bind JSON as text (`$1::text::jsonb`) or hand over the JavaScript
 * value, never a pre-stringified value under a json cast.
 */
export const POSTGRES_JS_SERIALIZERS: NonNullable<QueryOptions["serializers"]> = {
  114: (value) => JSON.stringify(value),
  3802: (value) => JSON.stringify(value),
};

const DRIVER_OPTIONS: QueryOptions = { serializers: POSTGRES_JS_SERIALIZERS };

export interface TestDb {
  db: PGlite;
  /**
   * Runs statements as the database owner, binding parameters the way the function's driver does
   * (see POSTGRES_JS_SERIALIZERS), and returns the result of the last. Code under test goes
   * through this.
   */
  runner: SqlRunner;
  /**
   * Direct access for seeding and assertions, with PGlite's own parameter handling. A test that
   * stands in for another client uses this, not the runner: pantry.test.ts replays the SQL
   * PostgREST sends, which binds a request body as given.
   */
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]>;
  exec(text: string): Promise<void>;
  close(): Promise<void>;
}

export interface CreateTestDbOptions {
  /** Load the pgTAP shim, for a script that runs the pgTAP files. */
  pgtap?: boolean;
}

export async function createListTestDb(options: CreateTestDbOptions = {}): Promise<TestDb> {
  const db = new PGlite({ extensions: { vector, pg_trgm, pgcrypto } as never });
  await db.exec(readFileSync(STUBS_FILE, "utf8"));
  await db.exec("create extension vector with schema extensions;");
  await db.exec("create extension pg_trgm with schema extensions;");
  await db.exec("create extension pgcrypto with schema extensions;");
  await db.exec('set search_path = "$user", public, extensions;');

  for (const name of HARNESS_MIGRATIONS) {
    const file = migrationFile(name);
    if (!file) throw new Error(`migration ${name} not found in ${MIGRATIONS_DIR}`);
    await db.exec(readFileSync(file, "utf8"));
  }
  if (options.pgtap) await db.exec(readFileSync(SHIM_FILE, "utf8"));

  const query = async <T = Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> => {
    const result = await db.query<T>(text, [...params]);
    return result.rows;
  };
  const wrap = (exec: {
    query<R>(text: string, params?: unknown[], options?: QueryOptions): Promise<{ rows: R[] }>;
  }): SqlRunner => ({
    query: async <R>(text: string, params: readonly unknown[]) =>
      (await exec.query<R>(text, [...params], DRIVER_OPTIONS)).rows,
    transaction: async () => {
      throw new Error("nested transactions are not supported by the test runner");
    },
  });
  const runner: SqlRunner = {
    query: wrap(db).query,
    transaction: (fn) => db.transaction(async (tx) => fn(wrap(tx))),
  };
  return {
    db,
    runner,
    query,
    exec: async (text) => {
      await db.exec(text);
    },
    close: () => db.close(),
  };
}
