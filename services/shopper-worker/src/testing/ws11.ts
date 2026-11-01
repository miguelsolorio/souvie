// Test-only: the WS09 PGlite harness (real migrations from identity to ws09_runs, Vault, pgmq and
// pg_cron stubs) plus the WS11 migration on top. It lives here, not in the run-approve harness,
// because that harness belongs to WS09; this one only adds one migration by name.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createRunsTestDb,
  MIGRATIONS_DIR,
  type RunsTestDb,
} from "../../../../supabase/functions/run-approve/testing/db.ts";

export const WS11_MIGRATION = "20261031170000_ws11_schedules_notifications.sql";

export type Ws11TestDb = RunsTestDb;

export async function createWs11TestDb(options: { pgtap?: boolean } = {}): Promise<Ws11TestDb> {
  const t = await createRunsTestDb(options);
  try {
    await t.exec(readFileSync(join(MIGRATIONS_DIR, WS11_MIGRATION), "utf8"));
  } catch (err) {
    await t.close();
    throw new Error(`the WS11 migration failed: ${(err as Error).message}`);
  }
  return t;
}
