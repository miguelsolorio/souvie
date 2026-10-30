import type { SupportedStorage } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
  clearPendingInvite,
  getPendingInvite,
  PENDING_INVITE_KEY,
  setPendingInvite,
} from "./pendingInvite";

const TOKEN = "9f2c4a7e1b3d5f60a8c2e4f6081a3c5e7092b4d6f8a1c3e5072941b3d5f7a9c1";

function fakeStorage(): SupportedStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => {
      data.set(key, value);
    },
    removeItem: async (key) => {
      data.delete(key);
    },
  };
}

describe("pending invite", () => {
  it("stores a token and reads it back", async () => {
    const storage = fakeStorage();
    expect(await getPendingInvite(storage)).toBeNull();
    await setPendingInvite(TOKEN, storage);
    expect(storage.data.get(PENDING_INVITE_KEY)).toBe(TOKEN);
    expect(await getPendingInvite(storage)).toBe(TOKEN);
  });

  it("clears the token", async () => {
    const storage = fakeStorage();
    await setPendingInvite(TOKEN, storage);
    await clearPendingInvite(storage);
    expect(await getPendingInvite(storage)).toBeNull();
  });

  it("refuses to store, and ignores on read, anything that is not a token", async () => {
    const storage = fakeStorage();
    await setPendingInvite("../../etc/passwd", storage);
    expect(storage.data.size).toBe(0);

    storage.data.set(PENDING_INVITE_KEY, "<script>alert(1)</script>");
    expect(await getPendingInvite(storage)).toBeNull();
  });
});
