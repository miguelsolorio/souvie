import { describe, expect, it } from "vitest";
import type { MpClient } from "./client";
import { fetchActiveHousehold, planModeOf } from "./hooks/useHousehold";
import {
  avatarPath,
  createHousehold,
  createInvite,
  getAvatarUrl,
  IdentityError,
  identityErrorMessage,
  isAvatarContentType,
  leaveHousehold,
  listHouseholdMembers,
  redeemInvite,
  removeMember,
  renameHousehold,
  setPlanMode,
  toIdentityError,
  updateDisplayName,
  uploadAvatar,
} from "./identity";

type Result = { data?: unknown; error?: { message: string } | null };

interface Call {
  op: string;
  args: unknown[];
}

/**
 * A stand-in for the pieces of supabase-js these helpers use. Every call is recorded, and every
 * query chain resolves to the next queued result.
 */
function fakeClient(results: Result[] = []) {
  const calls: Call[] = [];
  const queue = [...results];
  const next = (): Result => queue.shift() ?? { data: null, error: null };

  const chain = (label: string) => {
    const q: Record<string, unknown> = {};
    for (const method of [
      "select",
      "update",
      "delete",
      "eq",
      "is",
      "order",
      "limit",
      "maybeSingle",
    ]) {
      q[method] = (...args: unknown[]) => {
        calls.push({ op: `${label}.${method}`, args });
        return q;
      };
    }
    // biome-ignore lint/suspicious/noThenProperty: mimics PostgREST's awaitable query builder
    q.then = (resolve: (value: Result) => unknown) => resolve(next());
    return q;
  };

  const storageBucket = {
    upload: async (...args: unknown[]) => {
      calls.push({ op: "storage.upload", args });
      const r = next();
      return { data: r.data ?? null, error: r.error ?? null };
    },
    remove: async (...args: unknown[]) => {
      calls.push({ op: "storage.remove", args });
      return { data: null, error: null };
    },
    createSignedUrl: async (...args: unknown[]) => {
      calls.push({ op: "storage.createSignedUrl", args });
      const r = next();
      return { data: r.data ?? null, error: r.error ?? null };
    },
  };

  const client = {
    rpc: async (...args: unknown[]) => {
      calls.push({ op: "rpc", args });
      const r = next();
      return { data: r.data ?? null, error: r.error ?? null };
    },
    from: (table: string) => {
      calls.push({ op: "from", args: [table] });
      return chain(table);
    },
    storage: {
      from: (bucket: string) => {
        calls.push({ op: "storage.from", args: [bucket] });
        return storageBucket;
      },
    },
  } as unknown as MpClient;

  return { client, calls };
}

const ops = (calls: Call[]) => calls.map((c) => c.op);

describe("toIdentityError", () => {
  it("maps the codes the SQL functions raise", () => {
    for (const code of [
      "not_authenticated",
      "invalid_name",
      "not_owner",
      "not_a_member",
      "invite_not_found",
      "invite_used",
      "invite_expired",
    ] as const) {
      expect(toIdentityError({ message: code }).code).toBe(code);
    }
  });

  it("treats anything else as unknown and keeps the text", () => {
    const err = toIdentityError({ message: "permission denied for table households" });
    expect(err.code).toBe("unknown");
    expect(err.message).toContain("permission denied");
    expect(toIdentityError({ message: null }).code).toBe("unknown");
  });

  it("has a person-readable message for every code", () => {
    expect(identityErrorMessage(new IdentityError("invite_expired"))).toMatch(/expired/);
    expect(identityErrorMessage(new IdentityError("not_owner"))).toMatch(/owner/);
    expect(identityErrorMessage(new Error("boom"))).toMatch(/went wrong/);
  });
});

describe("RPC helpers", () => {
  it("createHousehold trims the name and returns the id", async () => {
    const { client, calls } = fakeClient([{ data: "house-id" }]);
    await expect(createHousehold(client, "  Dave Den ")).resolves.toBe("house-id");
    expect(calls[0]).toEqual({ op: "rpc", args: ["create_household", { name: "Dave Den" }] });
  });

  it("createHousehold rejects a blank name before calling the database", async () => {
    const { client, calls } = fakeClient();
    await expect(createHousehold(client, "   ")).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("createInvite and redeemInvite use the documented argument names", async () => {
    const { client, calls } = fakeClient([{ data: "tok" }, { data: "house-id" }]);
    await expect(createInvite(client, "h1")).resolves.toBe("tok");
    await expect(redeemInvite(client, "tok")).resolves.toBe("house-id");
    expect(calls.map((c) => c.args)).toEqual([
      ["create_invite", { household_id: "h1" }],
      ["redeem_invite", { token: "tok" }],
    ]);
  });

  it("surfaces database errors as IdentityError with a code", async () => {
    const { client } = fakeClient([{ error: { message: "invite_expired" } }]);
    await expect(redeemInvite(client, "tok")).rejects.toMatchObject({
      name: "IdentityError",
      code: "invite_expired",
    });
  });

  it("leaveHousehold passes the household id", async () => {
    const { client, calls } = fakeClient([{ data: null }]);
    await leaveHousehold(client, "h1");
    expect(calls[0]?.args).toEqual(["leave_household", { household_id: "h1" }]);
  });

  it("listHouseholdMembers fills missing names and avatars with null", async () => {
    const { client } = fakeClient([
      {
        data: [
          { user_id: "u1", role: "owner", display_name: null, avatar_url: null, joined_at: "t1" },
          {
            user_id: "u2",
            role: "member",
            display_name: "Bo",
            avatar_url: "u2/a.jpg",
            joined_at: "t2",
          },
        ],
      },
    ]);
    await expect(listHouseholdMembers(client, "h1")).resolves.toEqual([
      { user_id: "u1", role: "owner", display_name: null, avatar_url: null, joined_at: "t1" },
      {
        user_id: "u2",
        role: "member",
        display_name: "Bo",
        avatar_url: "u2/a.jpg",
        joined_at: "t2",
      },
    ]);
  });
});

describe("table helpers", () => {
  it("renameHousehold treats zero updated rows as not_owner", async () => {
    const { client } = fakeClient([{ data: [] }]);
    await expect(renameHousehold(client, "h1", "New name")).rejects.toMatchObject({
      code: "not_owner",
    });
  });

  it("renameHousehold succeeds when a row was updated", async () => {
    const { client, calls } = fakeClient([{ data: [{ id: "h1" }] }]);
    await expect(renameHousehold(client, "h1", " New name ")).resolves.toBeUndefined();
    expect(calls.find((c) => c.op === "households.update")?.args).toEqual([{ name: "New name" }]);
  });

  it("removeMember treats zero deleted rows as not_owner", async () => {
    const { client } = fakeClient([{ data: [] }]);
    await expect(removeMember(client, "h1", "u2")).rejects.toMatchObject({ code: "not_owner" });
  });

  it("updateDisplayName trims and writes only the caller's row", async () => {
    const { client, calls } = fakeClient([{ data: null }]);
    await updateDisplayName(client, "u1", " Alice ");
    expect(calls.find((c) => c.op === "profiles.update")?.args).toEqual([
      { display_name: "Alice" },
    ]);
    expect(calls.find((c) => c.op === "profiles.eq")?.args).toEqual(["user_id", "u1"]);
  });

  it("fetchActiveHousehold returns the newest membership merged with the role", async () => {
    const household = { id: "h2", name: "Newest" };
    const { client, calls } = fakeClient([
      { data: [{ role: "member", created_at: "t", households: household }] },
    ]);
    await expect(fetchActiveHousehold(client, "u1")).resolves.toEqual({
      id: "h2",
      name: "Newest",
      plan_mode: "simple",
      role: "member",
    });
    expect(calls.find((c) => c.op === "household_members.order")?.args).toEqual([
      "created_at",
      { ascending: false },
    ]);
  });

  it("fetchActiveHousehold carries the household's plan mode", async () => {
    const household = { id: "h2", name: "Every meal", plan_mode: "full" };
    const { client } = fakeClient([
      { data: [{ role: "owner", created_at: "t", households: household }] },
    ]);
    await expect(fetchActiveHousehold(client, "u1")).resolves.toMatchObject({
      plan_mode: "full",
      role: "owner",
    });
  });

  it("fetchActiveHousehold falls back to simple for a missing or unknown plan mode", async () => {
    for (const plan_mode of [undefined, null, "weekly"]) {
      const household = { id: "h2", name: "Old copy", plan_mode };
      const { client } = fakeClient([
        { data: [{ role: "owner", created_at: "t", households: household }] },
      ]);
      await expect(fetchActiveHousehold(client, "u1")).resolves.toMatchObject({
        plan_mode: "simple",
      });
    }
  });

  it("planModeOf reads the two modes and defaults everything else to simple", () => {
    expect(planModeOf("simple")).toBe("simple");
    expect(planModeOf("full")).toBe("full");
    expect(planModeOf(undefined)).toBe("simple");
    expect(planModeOf("")).toBe("simple");
    expect(planModeOf("FULL")).toBe("simple");
  });

  it("setPlanMode writes only plan_mode, on the one household", async () => {
    const { client, calls } = fakeClient([{ data: [{ id: "h1" }] }]);
    await expect(setPlanMode(client, "h1", "full")).resolves.toBeUndefined();
    expect(calls.find((c) => c.op === "households.update")?.args).toEqual([{ plan_mode: "full" }]);
    expect(calls.find((c) => c.op === "households.eq")?.args).toEqual(["id", "h1"]);
  });

  it("setPlanMode treats zero updated rows as not_owner, so a member is told so", async () => {
    const { client } = fakeClient([{ data: [] }]);
    await expect(setPlanMode(client, "h1", "simple")).rejects.toMatchObject({
      code: "not_owner",
    });
  });

  it("setPlanMode maps a database error and refuses a mode it does not know", async () => {
    const failing = fakeClient([{ data: null, error: { message: "not_owner" } }]);
    await expect(setPlanMode(failing.client, "h1", "full")).rejects.toMatchObject({
      code: "not_owner",
    });
    const { client, calls } = fakeClient();
    // @ts-expect-error a mode outside the enum never reaches the database
    await expect(setPlanMode(client, "h1", "dinner-only")).rejects.toThrow();
    expect(calls.some((c) => c.op === "households.update")).toBe(false);
  });

  it("fetchActiveHousehold returns null when the user has no household", async () => {
    const { client } = fakeClient([{ data: [] }]);
    await expect(fetchActiveHousehold(client, "u1")).resolves.toBeNull();
  });
});

describe("avatars", () => {
  const bytes = new Uint8Array([1, 2, 3]);

  it("builds paths inside the user's own folder", () => {
    expect(avatarPath("u1", "f1", "image/jpeg")).toBe("u1/f1.jpg");
    expect(avatarPath("u1", "f1", "image/png")).toBe("u1/f1.png");
    expect(avatarPath("u1", "f1", "image/webp")).toBe("u1/f1.webp");
  });

  it("accepts only the allowed image types", () => {
    expect(isAvatarContentType("image/jpeg")).toBe(true);
    expect(isAvatarContentType("image/gif")).toBe(false);
    expect(isAvatarContentType("text/html")).toBe(false);
  });

  it("uploads, points the profile at the file, and removes the old one", async () => {
    const { client, calls } = fakeClient([{ data: { path: "u1/f2.jpg" } }, { data: null }]);
    const path = await uploadAvatar(client, {
      userId: "u1",
      fileId: "f2",
      bytes,
      contentType: "image/jpeg",
      previousPath: "u1/f1.jpg",
    });
    expect(path).toBe("u1/f2.jpg");
    expect(calls.find((c) => c.op === "storage.upload")?.args).toEqual([
      "u1/f2.jpg",
      bytes,
      { contentType: "image/jpeg", upsert: false },
    ]);
    expect(calls.find((c) => c.op === "profiles.update")?.args).toEqual([
      { avatar_url: "u1/f2.jpg" },
    ]);
    expect(calls.filter((c) => c.op === "storage.remove").map((c) => c.args)).toEqual([
      [["u1/f1.jpg"]],
    ]);
  });

  it("refuses an empty or oversized file without touching storage", async () => {
    const { client, calls } = fakeClient();
    await expect(
      uploadAvatar(client, {
        userId: "u1",
        fileId: "f",
        bytes: new Uint8Array(0),
        contentType: "image/png",
      }),
    ).rejects.toThrow(/2 MB/);
    await expect(
      uploadAvatar(client, {
        userId: "u1",
        fileId: "f",
        bytes: new Uint8Array(2 * 1024 * 1024 + 1),
        contentType: "image/png",
      }),
    ).rejects.toThrow(/2 MB/);
    expect(calls).toHaveLength(0);
  });

  it("stops when the upload is rejected and leaves the profile alone", async () => {
    const { client, calls } = fakeClient([
      { error: { message: "new row violates row-level security policy" } },
    ]);
    await expect(
      uploadAvatar(client, { userId: "u1", fileId: "f", bytes, contentType: "image/png" }),
    ).rejects.toThrow(/row-level security/);
    expect(ops(calls)).not.toContain("profiles.update");
  });

  it("removes the new file when the profile update fails", async () => {
    const { client, calls } = fakeClient([
      { data: { path: "u1/f.png" } },
      { error: { message: "boom" } },
    ]);
    await expect(
      uploadAvatar(client, { userId: "u1", fileId: "f", bytes, contentType: "image/png" }),
    ).rejects.toBeInstanceOf(IdentityError);
    expect(calls.filter((c) => c.op === "storage.remove").map((c) => c.args)).toEqual([
      [["u1/f.png"]],
    ]);
  });

  it("getAvatarUrl returns a signed URL, or null for no path or an error", async () => {
    const ok = fakeClient([{ data: { signedUrl: "https://x/y?token=1" } }]);
    await expect(getAvatarUrl(ok.client, "u1/a.jpg")).resolves.toBe("https://x/y?token=1");

    const none = fakeClient();
    await expect(getAvatarUrl(none.client, null)).resolves.toBeNull();
    expect(none.calls).toHaveLength(0);

    const failed = fakeClient([{ error: { message: "not found" } }]);
    await expect(getAvatarUrl(failed.client, "u1/a.jpg")).resolves.toBeNull();
  });
});
