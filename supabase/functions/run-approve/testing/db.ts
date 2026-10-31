// Test harness only (WS09): a real Postgres for the runs migration, run-approve's SQL, and the
// shopper worker's store, with no container. PGlite is Postgres 18 compiled to WASM; CI and the
// hosted project run Postgres 17, and the SQL here is plain across both.
//
// It applies the repo's own migrations by name, in timestamp order, from identity to ws09_runs.
// What it stands in for:
//   * Supabase's auth and storage schemas and API roles: ../../suggest/testing/supabase-stubs.sql
//     (one copy, shared with the suggest and list-build harnesses).
//   * Vault, pgmq and pg_cron: ./platform-stubs.sql. The retail migration's
//     `create extension supabase_vault` line is skipped, since the stub provides the schema.
//   * pgTAP: ../../list-build/testing/pgtap-shim.sql, for running supabase/tests files.
// Nothing is copied from the migrations.
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
export const MIGRATIONS_DIR = join(FUNCTIONS_DIR, "..", "migrations");
export const TESTS_DIR = join(FUNCTIONS_DIR, "..", "tests");
const SUPABASE_STUBS = join(FUNCTIONS_DIR, "suggest", "testing", "supabase-stubs.sql");
const PLATFORM_STUBS = join(HERE, "platform-stubs.sql");
const PGTAP_SHIM = join(FUNCTIONS_DIR, "list-build", "testing", "pgtap-shim.sql");

/** The migrations the harness applies, in this order, by name (the timestamp prefix is ignored). */
export const HARNESS_MIGRATIONS = [
  "identity",
  "identity_functions",
  "ingredients",
  "proposals_household_fk",
  "recipes",
  "ai_runs",
  "ws07_retail",
  "retail_revoke_on_member_removed",
  "planning",
  "ws06_preferences",
  "recipes_catalog_read",
  "recipe_ingredients_container",
  "lists",
  "ws09_runs",
] as const;

const SKIPPED_STATEMENTS = ["create extension if not exists supabase_vault with schema vault;"];

function migrationSql(name: string): string {
  const match = readdirSync(MIGRATIONS_DIR).find((file) =>
    new RegExp(`^\\d+_${name}\\.sql$`).test(file),
  );
  if (!match) throw new Error(`migration ${name} not found in ${MIGRATIONS_DIR}`);
  let sql = readFileSync(join(MIGRATIONS_DIR, match), "utf8");
  for (const statement of SKIPPED_STATEMENTS) sql = sql.replace(statement, "");
  return sql;
}

export interface RunsTestDb {
  db: PGlite;
  /** Statements as the database owner, like WORKER_DATABASE_URL. */
  runner: SqlRunner;
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]>;
  exec(text: string): Promise<void>;
  close(): Promise<void>;
}

export interface CreateRunsTestDbOptions {
  /** Load the pgTAP shim, for a test that runs supabase/tests files. */
  pgtap?: boolean;
}

export async function createRunsTestDb(options: CreateRunsTestDbOptions = {}): Promise<RunsTestDb> {
  const db = new PGlite({ extensions: { vector, pg_trgm, pgcrypto } as never });
  await db.exec(readFileSync(SUPABASE_STUBS, "utf8"));
  await db.exec(readFileSync(PLATFORM_STUBS, "utf8"));
  await db.exec("create extension vector with schema extensions;");
  await db.exec("create extension pg_trgm with schema extensions;");
  await db.exec("create extension pgcrypto with schema extensions;");
  await db.exec('set search_path = "$user", public, extensions;');
  for (const name of HARNESS_MIGRATIONS) {
    try {
      await db.exec(migrationSql(name));
    } catch (err) {
      throw new Error(`migration ${name} failed: ${(err as Error).message}`);
    }
  }
  if (options.pgtap) await db.exec(readFileSync(PGTAP_SHIM, "utf8"));

  const query = async <T = Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> => (await db.query<T>(text, [...params])).rows;

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
