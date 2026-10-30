import { describe, expect, it } from "vitest";
import {
  CreateHouseholdInput,
  Household,
  HouseholdMember,
  HouseholdRole,
  HouseholdRosterEntry,
  Profile,
  ProfilePreferences,
  ProfileUpdateInput,
} from "./identity";

const ID_A = "a1111111-1111-4111-8111-111111111111";
const ID_B = "b2222222-2222-4222-8222-222222222222";
const NOW = "2026-10-30T07:12:14.123456+00:00";

const household = {
  id: ID_A,
  name: "Alice Home",
  zip: "98019",
  default_connection_id: null,
  created_by: ID_B,
  created_at: NOW,
  updated_at: NOW,
  deleted_at: null,
};

describe("HouseholdRole", () => {
  it("allows owner and member only", () => {
    expect(HouseholdRole.parse("owner")).toBe("owner");
    expect(HouseholdRole.parse("member")).toBe("member");
    expect(HouseholdRole.safeParse("admin").success).toBe(false);
  });
});

describe("Household", () => {
  it("parses a row as PostgREST returns it", () => {
    expect(Household.parse(household)).toEqual(household);
  });

  it("accepts null zip, creator, and connection", () => {
    const parsed = Household.parse({ ...household, zip: null, created_by: null });
    expect(parsed.zip).toBeNull();
    expect(parsed.created_by).toBeNull();
  });

  it("rejects an empty name, an over-long name, and a bad id", () => {
    expect(Household.safeParse({ ...household, name: "" }).success).toBe(false);
    expect(Household.safeParse({ ...household, name: "x".repeat(81) }).success).toBe(false);
    expect(Household.safeParse({ ...household, id: "not-a-uuid" }).success).toBe(false);
  });

  it("rejects a timestamp without an offset", () => {
    expect(Household.safeParse({ ...household, created_at: "2026-10-30 07:12:14" }).success).toBe(
      false,
    );
  });
});

describe("HouseholdMember", () => {
  const member = {
    household_id: ID_A,
    user_id: ID_B,
    role: "member",
    invited_by: ID_A,
    created_at: NOW,
  };

  it("parses a member row", () => {
    expect(HouseholdMember.parse(member)).toEqual(member);
  });

  it("allows a null inviter and rejects an unknown role", () => {
    expect(HouseholdMember.parse({ ...member, invited_by: null }).invited_by).toBeNull();
    expect(HouseholdMember.safeParse({ ...member, role: "guest" }).success).toBe(false);
  });
});

describe("HouseholdRosterEntry", () => {
  it("parses a list_household_members row with a missing name and avatar", () => {
    const entry = {
      user_id: ID_A,
      role: "owner",
      display_name: null,
      avatar_url: null,
      joined_at: NOW,
    };
    expect(HouseholdRosterEntry.parse(entry)).toEqual(entry);
  });
});

describe("ProfilePreferences", () => {
  it("accepts the empty object a new profile starts with", () => {
    expect(ProfilePreferences.parse({})).toEqual({});
  });

  it("parses the shape documented in docs/02-data-model.md", () => {
    const prefs = {
      diets: ["vegetarian"],
      allergies: ["peanut", "sesame"],
      dislikes: ["cilantro"],
      cuisines: ["thai", "mexican"],
      skill: "comfortable",
      weeknight_minutes: 30,
      budget_per_week_usd: 150,
      equipment: ["slow cooker"],
      portions: 4,
      leftovers: "prefer",
      primary_store_id: "70100123",
      notes: "Kid hates mushrooms",
    };
    expect(ProfilePreferences.parse(prefs)).toEqual(prefs);
  });

  it("keeps unknown keys so WS06 can extend the shape", () => {
    const parsed = ProfilePreferences.parse({ allergies: ["milk"], householdSize: 3 });
    expect(parsed).toEqual({ allergies: ["milk"], householdSize: 3 });
  });

  it("rejects wrong types in the known fields", () => {
    expect(ProfilePreferences.safeParse({ allergies: "peanut" }).success).toBe(false);
    expect(ProfilePreferences.safeParse({ skill: "expert" }).success).toBe(false);
    expect(ProfilePreferences.safeParse({ leftovers: "sometimes" }).success).toBe(false);
    expect(ProfilePreferences.safeParse({ weeknight_minutes: 0 }).success).toBe(false);
    expect(ProfilePreferences.safeParse({ budget_per_week_usd: -1 }).success).toBe(false);
    expect(ProfilePreferences.safeParse({ dinners_per_week: 9 }).success).toBe(false);
    expect(ProfilePreferences.safeParse({ household_size: { adults: 0, kids: 0 } }).success).toBe(false);
  });
});

describe("Profile", () => {
  const profile = {
    user_id: ID_A,
    display_name: "Alice",
    avatar_url: `${ID_A}/me.jpg`,
    preferences: { allergies: ["peanut"] },
    created_at: NOW,
    updated_at: NOW,
  };

  it("parses a profile row", () => {
    expect(Profile.parse(profile)).toEqual(profile);
  });

  it("defaults preferences to an empty object and allows a null name and avatar", () => {
    const { preferences: _omitted, ...withoutPreferences } = profile;
    const parsed = Profile.parse({ ...withoutPreferences, display_name: null, avatar_url: null });
    expect(parsed.preferences).toEqual({});
    expect(parsed.display_name).toBeNull();
    expect(parsed.avatar_url).toBeNull();
  });
});

describe("form inputs", () => {
  it("trims a household name and rejects a blank one", () => {
    expect(CreateHouseholdInput.parse({ name: "  Dave Den  " })).toEqual({ name: "Dave Den" });
    expect(CreateHouseholdInput.safeParse({ name: "   " }).success).toBe(false);
    expect(CreateHouseholdInput.safeParse({ name: "x".repeat(81) }).success).toBe(false);
    expect(CreateHouseholdInput.safeParse({ name: "x".repeat(80) }).success).toBe(true);
  });

  it("trims a display name and rejects a blank one", () => {
    expect(ProfileUpdateInput.parse({ display_name: " Alice " })).toEqual({
      display_name: "Alice",
    });
    expect(ProfileUpdateInput.safeParse({ display_name: "" }).success).toBe(false);
  });
});
