// Runs supabase/tests/ws09_runs_rls.sql on PGlite through the pgTAP shim, because the development
// Mac has no container runtime for `supabase test db`. CI runs the same file with the real pgTAP,
// the real pgmq and pg_cron. The ws07 retail file runs too, as a check that the Vault stub is
// faithful enough for the migrations this harness loads.
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runPgTapFile } from "../list-build/testing/pgtap.ts";
import { createRunsTestDb, type RunsTestDb, TESTS_DIR } from "./testing/db.ts";

let t: RunsTestDb;

beforeAll(async () => {
  t = await createRunsTestDb({ pgtap: true });
}, 120_000);

afterAll(async () => {
  await t?.close();
});

describe("ws09 pgTAP on PGlite", () => {
  it("ws09_runs_rls.sql passes", async () => {
    const report = await runPgTapFile(t as never, join(TESTS_DIR, "ws09_runs_rls.sql"));
    expect(report.failures).toEqual([]);
    expect(report.summary).toEqual([]);
    expect(report.ran).toBe(report.planned);
    expect(report.ran).toBeGreaterThan(80);
  }, 120_000);
});
