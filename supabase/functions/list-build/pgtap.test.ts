// Runs the repo's pgTAP files on PGlite through a small shim (testing/pgtap-shim.sql), because the
// development Mac has no container runtime for `supabase test db`. CI runs the real thing.
//
// 004_rls_planning.sql (WS04) is here as a check on the shim itself: if the shim reports a failure
// on a file that passes under real pgTAP in CI, the shim is wrong, not the file. 006 is this
// workstream's: the lists migration's RLS, grants, triggers, and Realtime publication.
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createListTestDb, TESTS_DIR, type TestDb } from "./testing/db.ts";
import { runPgTapFile } from "./testing/pgtap.ts";

let t: TestDb;

beforeAll(async () => {
  t = await createListTestDb({ pgtap: true });
}, 120_000);

afterAll(async () => {
  await t?.close();
});

describe("pgTAP files on PGlite", () => {
  it("004_rls_planning.sql passes under the shim (the shim agrees with real pgTAP)", async () => {
    const report = await runPgTapFile(t, join(TESTS_DIR, "004_rls_planning.sql"));
    expect(report.failures).toEqual([]);
    expect(report.summary).toEqual([]);
    expect(report.ran).toBe(report.planned);
  }, 120_000);

  it("006_rls_lists.sql passes", async () => {
    const report = await runPgTapFile(t, join(TESTS_DIR, "006_rls_lists.sql"));
    expect(report.failures).toEqual([]);
    expect(report.summary).toEqual([]);
    expect(report.ran).toBe(report.planned);
    expect(report.ran).toBeGreaterThan(90);
  }, 120_000);
});
