// WS08 fix round, items 5 and 7 (lifted from the reviewer's reproductions), on the real migration
// in PGlite. CI asserts the same rules in supabase/tests/ws08_tier3_rls.sql.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTier3TestDb, type Tier3TestDb } from "./testing/db.ts";

const ALICE = "a1111111-1111-4111-8111-111111111111";
const CAROL = "c3333333-3333-4333-8333-333333333333";
const BOB = "b2222222-2222-4222-8222-222222222222";
const HA = "0a000000-0000-4000-8000-00000000000a";
const HB = "0b000000-0000-4000-8000-00000000000b";
const CURRENT = "2026-10-31";
const HERE = dirname(fileURLToPath(import.meta.url));

let t: Tier3TestDb;

beforeAll(async () => {
  t = await createTier3TestDb();
  await t.exec(`
    insert into auth.users (id, email, raw_user_meta_data) values
      ('${ALICE}', 'alice@example.test', '{}'),
      ('${BOB}', 'bob@example.test', '{}'),
      ('${CAROL}', 'carol@example.test', '{}');
    insert into public.households (id, name, created_by) values
      ('${HA}', 'A', '${ALICE}'), ('${HB}', 'B', '${BOB}');
    insert into public.household_members (household_id, user_id, role) values
      ('${HA}', '${ALICE}', 'owner'), ('${HA}', '${CAROL}', 'member'), ('${HB}', '${BOB}', 'owner');
  `);
}, 120_000);

afterAll(async () => {
  await t?.close();
});

type Consent = { retailers: string[]; copy_version: string };

async function consent(household: string, retailers: string[], version: string): Promise<Consent> {
  return t.run({ sub: household === HA ? ALICE : BOB }, async (q) => {
    const [row] = await q<{ v: Consent }>("select public.record_tier3_consent($1, $2, $3) as v", [
      household,
      retailers,
      version,
    ]);
    if (!row) throw new Error("no consent returned");
    return row.v;
  });
}

describe("item 5: record_tier3_consent across a copy version change", () => {
  it("keeps the union while the version stays the same", async () => {
    await consent(HA, ["safeway"], CURRENT);
    expect(await consent(HA, ["costco"], CURRENT)).toMatchObject({
      retailers: ["costco", "safeway"],
      copy_version: CURRENT,
    });
  });

  it("replaces the list with only the retailers accepted when the version changes", async () => {
    // Safeway was accepted only at the old copy, so a new copy accepted for Costco covers Costco.
    expect(await consent(HA, ["costco"], "2026-12-01")).toEqual(
      expect.objectContaining({ retailers: ["costco"], copy_version: "2026-12-01" }),
    );
    // Back to the current copy for Safeway: a version change again, so only Safeway.
    expect(await consent(HA, ["safeway", "safeway"], CURRENT)).toMatchObject({
      retailers: ["safeway"],
      copy_version: CURRENT,
    });
  });
});

describe("item 7: connect_browser_session requires consent at the current copy version", () => {
  it("refuses consent recorded at an older version, and accepts it at the current one", async () => {
    await consent(HB, ["costco"], "2020-01-01");
    await expect(
      t.run({ sub: BOB }, (q) => q("select public.connect_browser_session($1, 'costco')", [HB])),
    ).rejects.toThrow(/stale_consent/);
    await consent(HB, ["costco"], CURRENT);
    const id = await t.run({ sub: BOB }, async (q) => {
      const [row] = await q<{ id: string }>(
        "select public.connect_browser_session($1, 'costco') as id",
        [HB],
      );
      return row?.id;
    });
    expect(typeof id).toBe("string");
  });

  it("the SQL copy version is consent.ts's CONSENT_VERSION", async () => {
    const [row] = await t.query<{ v: string }>("select public.tier3_consent_version() as v");
    const consentTs = readFileSync(
      join(HERE, "..", "..", "..", "apps", "mobile", "src", "features", "tier3", "consent.ts"),
      "utf8",
    );
    const version = /export const CONSENT_VERSION = "([^"]+)"/.exec(consentTs)?.[1];
    expect(row?.v).toBe(version);
  });
});

describe("revoke after leaving the household (kept: revocation is always safe)", () => {
  it("a removed member can still revoke their own connection but cannot fetch its key", async () => {
    let connectionId = "";
    await t.run({ sub: CAROL }, async (q) => {
      await q("select public.record_tier3_consent($1, array['safeway'], $2)", [HA, CURRENT]);
      const [row] = await q<{ id: string }>(
        "select public.connect_browser_session($1, 'safeway') as id",
        [HA],
      );
      connectionId = row?.id ?? "";
    });
    await t.exec(`delete from public.household_members where user_id = '${CAROL}'`);
    // The member-removed trigger (CCR2) already revoked it; revoking again is a no-op.
    await t.run({ sub: CAROL }, async (q) => {
      await expect(q("select public.connection_session_key($1)", [connectionId])).rejects.toThrow(
        /not_allowed|connection_revoked/,
      );
      await q("select public.revoke_browser_connection($1)", [connectionId]);
    });
    const [row] = await t.query<{ status: string; vault_secret_id: string | null }>(
      "select status::text as status, vault_secret_id::text from public.retailer_connections where id = $1",
      [connectionId],
    );
    expect(row).toEqual({ status: "revoked", vault_secret_id: null });
  });
});
