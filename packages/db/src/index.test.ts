import { describe, expect, it } from "vitest";
import { Constants } from "./types.generated";

describe("@mp/db", () => {
  it("loads and exports the identity API", async () => {
    const mod = await import("./index");
    expect(mod.packageName).toBe("@mp/db");
    for (const name of [
      "createClient",
      "SupabaseProvider",
      "useSupabase",
      "useSession",
      "useHousehold",
      "useHouseholdMembers",
      "useProfile",
      "createHousehold",
      "redeemInvite",
    ]) {
      expect(mod, name).toHaveProperty(name);
    }
  });

  it("resolves its workspace dependencies", async () => {
    await expect(import("@mp/core")).resolves.toBeDefined();
  });

  it("agrees with @mp/core on the household roles", async () => {
    const { HouseholdRole } = await import("@mp/core");
    expect([...Constants.public.Enums.household_members_role]).toEqual(HouseholdRole.options);
  });
});

describe("createClient", () => {
  it("builds a client that points at the given project", async () => {
    const { createClient } = await import("./client");
    const client = createClient("http://127.0.0.1:54321", "anon-key");
    expect(typeof client.auth.getSession).toBe("function");
    expect(typeof client.rpc).toBe("function");
  });
});
