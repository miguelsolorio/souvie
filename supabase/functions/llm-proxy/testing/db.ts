// Test harness only (WS08): a real Postgres for the Tier 3 migration and llm-proxy's spend query,
// with no container. PGlite is Postgres compiled to WASM; the migrations are the repo's own files,
// loaded unchanged except for one line: the WS07 retail migration's `create extension
// supabase_vault`, which PGlite does not have. Vault and pg_cron come from platform-stubs.sql
// instead (see suggest/testing/db.ts for why those migrations are otherwise left out), and the
// API roles, auth and storage from the stubs the suggest harness ships.
//
// CI runs the real stack (`supabase test db`); this gives the same pass or fail before a push.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { vector } from "@electric-sql/pglite-pgvector";

const HERE = dirname(fileURLToPath(import.meta.url));
const FUNCTIONS_DIR = join(HERE, "..", "..");
const MIGRATIONS_DIR = join(FUNCTIONS_DIR, "..", "migrations");
export const TESTS_DIR = join(FUNCTIONS_DIR, "..", "tests");
const SUPABASE_STUBS = join(FUNCTIONS_DIR, "suggest", "testing", "supabase-stubs.sql");
const PGTAP_SHIM = join(FUNCTIONS_DIR, "list-build", "testing", "pgtap-shim.sql");

/** The migrations the harness applies, in order, by name (the timestamp prefix is ignored). */
export const HARNESS_MIGRATIONS = [
  "identity",
  "identity_functions",
  "ingredients",
  "proposals_household_fk",
  "ai_runs",
  "ws07_retail",
  "retail_revoke_on_member_removed",
  "ws08_tier3",
] as const;

function migrationSql(name: string): string {
  const file = readdirSync(MIGRATIONS_DIR).find((f) => new RegExp(`^\\d+_${name}\\.sql$`).test(f));
  if (!file) throw new Error(`migration ${name} not found in ${MIGRATIONS_DIR}`);
  const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
  return sql.replace(
    /^create extension if not exists supabase_vault[^;]*;$/m,
    "-- (Vault stubbed)",
  );
}

export interface Tier3TestDb {
  db: PGlite;
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]>;
  exec(text: string): Promise<void>;
  /** Runs `fn` as a signed-in user (or the service role), inside a transaction rolled back after. */
  as<T>(
    who: { sub: string } | "service_role",
    fn: (q: Tier3TestDb["query"]) => Promise<T>,
  ): Promise<T>;
  close(): Promise<void>;
}

export async function createTier3TestDb(options: { pgtap?: boolean } = {}): Promise<Tier3TestDb> {
  const db = new PGlite({ extensions: { vector, pg_trgm, pgcrypto } as never });
  await db.exec(readFileSync(SUPABASE_STUBS, "utf8"));
  await db.exec(readFileSync(join(HERE, "platform-stubs.sql"), "utf8"));
  await db.exec("create extension vector with schema extensions;");
  await db.exec("create extension pg_trgm with schema extensions;");
  await db.exec("create extension pgcrypto with schema extensions;");
  await db.exec('set search_path = "$user", public, extensions;');
  for (const name of HARNESS_MIGRATIONS) await db.exec(migrationSql(name));
  if (options.pgtap) {
    await db.exec(readFileSync(PGTAP_SHIM, "utf8"));
    await db.exec(readFileSync(join(HERE, "pgtap-extra.sql"), "utf8"));
  }

  const query = async <T = Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> => (await db.query<T>(text, [...params])).rows;

  return {
    db,
    query,
    exec: async (text) => {
      await db.exec(text);
    },
    async as(who, fn) {
      let out: unknown;
      await db
        .transaction(async (tx) => {
          const claims =
            who === "service_role"
              ? { role: "service_role" }
              : { sub: who.sub, role: "authenticated" };
          await tx.query("select set_config('request.jwt.claims', $1, true)", [
            JSON.stringify(claims),
          ]);
          await tx.exec(
            `set local role ${who === "service_role" ? "service_role" : "authenticated"}`,
          );
          out = await fn(
            async (text, params = []) => (await tx.query(text, [...params])).rows as never,
          );
          throw new RollbackSignal();
        })
        .catch((err: unknown) => {
          if (!(err instanceof RollbackSignal)) throw err;
        });
      return out as never;
    },
    close: () => db.close(),
  };
}

class RollbackSignal extends Error {}
