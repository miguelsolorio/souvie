// Test harness only (WS05): a real Postgres for list-build's SQL and for the lists migration's
// policies and triggers, with no container. PGlite is Postgres compiled to WASM; it runs our
// migrations unchanged. Two stand-ins matter, the same two as the suggest harness:
//   * the version: PGlite 0.5 is Postgres 18, the hosted project and CI run Postgres 17. The SQL
//     here is plain and stable across both.
//   * the platform: Supabase's auth and storage schemas and API roles come from the stubs file the
//     suggest harness already ships (../../suggest/testing/supabase-stubs.sql), read from there so
//     there is one copy.
// The migrations are the repo's own files, loaded below. Nothing is copied.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
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

export interface TestDb {
  db: PGlite;
  /** Runs statements as the database owner and returns the result of the last. */
  runner: SqlRunner;
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
    query<R>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
  }): SqlRunner => ({
    query: async <R>(text: string, params: readonly unknown[]) =>
      (await exec.query<R>(text, [...params])).rows,
    transaction: async () => {
      throw new Error("nested transactions are not supported by the test runner");
    },
  });
  const runner: SqlRunner = {
    query: (text, params) => query(text, params),
    transaction: (fn) => db.transaction(async (tx) => fn(wrap(tx as never))),
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
