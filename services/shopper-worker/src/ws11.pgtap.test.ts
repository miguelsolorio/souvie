// Runs supabase/tests/ws11_schedules_notifications.sql on PGlite through the pgTAP shim, because
// the development Mac has no container runtime for `supabase test db`. CI runs the same file with
// the real pgTAP, the real pgmq and pg_cron.
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runPgTapFile } from "../../../supabase/functions/list-build/testing/pgtap.ts";
import { TESTS_DIR } from "../../../supabase/functions/run-approve/testing/db.ts";
import { createWs11TestDb, type Ws11TestDb } from "./testing/ws11.ts";

let t: Ws11TestDb;

beforeAll(async () => {
  t = await createWs11TestDb({ pgtap: true });
}, 120_000);

afterAll(async () => {
  await t?.close();
});

describe("ws11 pgTAP on PGlite", () => {
  it("ws11_schedules_notifications.sql passes", async () => {
    const report = await runPgTapFile(
      t as never,
      join(TESTS_DIR, "ws11_schedules_notifications.sql"),
    );
    expect(report.failures).toEqual([]);
    expect(report.summary).toEqual([]);
    expect(report.ran).toBe(report.planned);
    expect(report.ran).toBeGreaterThan(150);
  }, 120_000);
});
