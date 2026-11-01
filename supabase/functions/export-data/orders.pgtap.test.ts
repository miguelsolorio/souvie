// Runs supabase/tests/ws12_orders_rls.sql on PGlite through the pgTAP shim, because the development
// Mac has no container runtime for `supabase test db`. CI runs the same file with the real pgTAP.
//
// The harness is the runs one (supabase/functions/run-approve/testing): the repo's own migrations
// applied by name from identity to ws09_runs, with Vault, pgmq and pg_cron stood in. The WS12
// migration is applied on top of it here, from its own file, so nothing is copied.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runPgTapFile } from "../list-build/testing/pgtap.ts";
import {
  createRunsTestDb,
  MIGRATIONS_DIR,
  type RunsTestDb,
  TESTS_DIR,
} from "../run-approve/testing/db.ts";

let t: RunsTestDb;

function ws12Migration(): string {
  const file = readdirSync(MIGRATIONS_DIR).find((name) =>
    /^\d+_ws12_orders_history\.sql$/.test(name),
  );
  if (!file) throw new Error(`the ws12_orders_history migration is not in ${MIGRATIONS_DIR}`);
  return readFileSync(join(MIGRATIONS_DIR, file), "utf8");
}

beforeAll(async () => {
  t = await createRunsTestDb({ pgtap: true });
  await t.exec(ws12Migration());
}, 120_000);

afterAll(async () => {
  await t?.close();
});

describe("ws12 pgTAP on PGlite", () => {
  it("ws12_orders_rls.sql passes", async () => {
    const report = await runPgTapFile(t as never, join(TESTS_DIR, "ws12_orders_rls.sql"));
    expect(report.failures).toEqual([]);
    expect(report.summary).toEqual([]);
    expect(report.ran).toBe(report.planned);
    expect(report.ran).toBeGreaterThan(100);
  }, 120_000);

  it("the migration stores no price history (acceptance 9)", () => {
    // Comments and code alike: the word does not appear, so nothing in the file is a price column.
    expect(ws12Migration().toLowerCase()).not.toContain("price");
  });
});
