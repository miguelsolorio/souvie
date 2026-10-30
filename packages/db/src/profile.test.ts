import { describe, expect, it } from "vitest";
import type { MpClient } from "./client";
import { fetchProfile, PROFILE_COLUMNS } from "./hooks/useProfile";

function fakeClient(result: { data: unknown; error: { message: string } | null }) {
  const calls: { table: string; select?: string; eq?: [string, string] }[] = [];
  const client = {
    from(table: string) {
      const call: (typeof calls)[number] = { table };
      calls.push(call);
      const q = {
        select(columns: string) {
          call.select = columns;
          return q;
        },
        eq(column: string, value: string) {
          call.eq = [column, value];
          return q;
        },
        maybeSingle: async () => result,
      };
      return q;
    },
  } as unknown as MpClient;
  return { client, calls };
}

describe("fetchProfile", () => {
  it("asks for named columns, never * and never the taste embedding", async () => {
    const { client, calls } = fakeClient({ data: { user_id: "u1" }, error: null });
    await fetchProfile(client, "u1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.table).toBe("profiles");
    expect(calls[0]?.select).toBe(PROFILE_COLUMNS);
    expect(calls[0]?.select).not.toContain("*");
    expect(calls[0]?.select).not.toContain("taste_embedding");
    expect(calls[0]?.eq).toEqual(["user_id", "u1"]);
  });

  it("lists every other profiles column, so a screen loses nothing it had", () => {
    const columns = PROFILE_COLUMNS.split(",").map((c) => c.trim());
    expect(columns.sort()).toEqual(
      [
        "avatar_url",
        "costco_member",
        "created_at",
        "display_name",
        "onboarding_step",
        "preferences",
        "updated_at",
        "user_id",
      ].sort(),
    );
  });

  it("returns the row, or null when there is none", async () => {
    const row = { user_id: "u1", display_name: "Ann" };
    expect(await fetchProfile(fakeClient({ data: row, error: null }).client, "u1")).toEqual(row);
    expect(await fetchProfile(fakeClient({ data: null, error: null }).client, "u1")).toBeNull();
  });

  it("maps a database error", async () => {
    await expect(
      fetchProfile(fakeClient({ data: null, error: { message: "boom" } }).client, "u1"),
    ).rejects.toMatchObject({ name: "IdentityError" });
  });
});
