// Runs supabase/tests/ws08_tier3_rls.sql on PGlite through the WS05 pgTAP shim, because the
// development Mac has no container runtime for `supabase test db`. CI runs the same file with the
// real pgTAP on the real stack (real Vault, real Storage, and WS09's shopping_runs once merged).
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runPgTapFile } from "../list-build/testing/pgtap.ts";
import { createTier3TestDb, TESTS_DIR, type Tier3TestDb } from "./testing/db.ts";

let t: Tier3TestDb;

beforeAll(async () => {
  t = await createTier3TestDb({ pgtap: true });
}, 120_000);

afterAll(async () => {
  await t?.close();
});

describe("ws08_tier3_rls.sql on PGlite", () => {
  it("passes every assertion it plans", async () => {
    const report = await runPgTapFile(t as never, join(TESTS_DIR, "ws08_tier3_rls.sql"));
    expect(report.failures).toEqual([]);
    expect(report.summary).toEqual([]);
    expect(report.planned).toBe(68);
    expect(report.ran).toBe(report.planned);
  }, 120_000);
});
