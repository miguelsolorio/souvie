// Runs supabase/tests/ws15_observability.sql on PGlite through the pgTAP shim, because the
// development Mac has no container runtime for `supabase test db`. CI runs the same file with the
// real pgTAP on the real stack.
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runPgTapFile } from "../../../../supabase/functions/list-build/testing/pgtap.ts";
import {
  createRunsTestDb,
  type RunsTestDb,
  TESTS_DIR,
} from "../../../../supabase/functions/run-approve/testing/db.ts";

let t: RunsTestDb;

beforeAll(async () => {
  t = await createRunsTestDb({ pgtap: true, extraMigrations: ["ws15_observability"] });
}, 120_000);

afterAll(async () => {
  await t?.close();
});

describe("ws15_observability.sql on PGlite", () => {
  it("passes every assertion it plans", async () => {
    const report = await runPgTapFile(t as never, join(TESTS_DIR, "ws15_observability.sql"));
    expect(report.failures).toEqual([]);
    expect(report.summary).toEqual([]);
    expect(report.ran).toBe(report.planned);
    expect(report.planned).toBe(47);
  }, 120_000);
});
