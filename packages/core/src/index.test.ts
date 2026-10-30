import { describe, expect, it } from "vitest";

describe("@mp/core", () => {
  it("exports the identity schemas from WS01", async () => {
    const mod = await import("./index");
    expect(Object.keys(mod)).toEqual(
      expect.arrayContaining([
        "Household",
        "HouseholdMember",
        "Profile",
        "ProfilePreferences",
        "HouseholdRole",
      ]),
    );
  });
});
