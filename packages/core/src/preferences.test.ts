import { describe, expect, it } from "vitest";
import { LEFTOVER_STANCES, ProfilePreferences, SKILL_LEVELS } from "./identity.ts";
import {
  ALLERGENS,
  Allergen,
  BudgetLeftoversInput,
  budgetLeftoversToPreferences,
  CALIBRATION_CARD_COUNT,
  comingWeekStart,
  DIETS,
  Diet,
  DietsAllergiesInput,
  DislikesCuisinesInput,
  defaultPreferences,
  EatersInput,
  ENFORCED_DIETS,
  eatersToPreferences,
  HouseholdNameInput,
  isOnboardingComplete,
  LEFTOVERS,
  mergePreferences,
  nextOnboardingStep,
  ONBOARDING_STEP_COUNT,
  ONBOARDING_STEPS,
  SKILLS,
  StoresInput,
  SUGGEST_ERROR_CODES,
  SUGGEST_ERROR_MESSAGES,
  SuggestCalibrationResponse,
  SuggestEntry,
  SuggestPlanResponse,
  SuggestRequest,
  SuggestSwapResponse,
  SWAP_EXCLUDE_MAX,
  TimeSkillInput,
  WHY_MAX_CHARS,
} from "./preferences.ts";

const HOUSEHOLD = "0a000000-0000-4000-8000-00000000000a";
const RECIPE = "c77e0000-0000-4000-8000-000000000001";

describe("vocabularies", () => {
  it("lists the eleven diets and nine allergens from the brief", () => {
    expect(DIETS).toEqual([
      "omnivore",
      "vegetarian",
      "vegan",
      "pescatarian",
      "halal",
      "kosher",
      "gluten_free",
      "dairy_free",
      "low_carb",
      "keto",
      "paleo",
    ]);
    expect(ALLERGENS).toEqual([
      "peanut",
      "tree_nut",
      "milk",
      "egg",
      "wheat",
      "soy",
      "fish",
      "shellfish",
      "sesame",
    ]);
  });

  it("only enforces diets that exist", () => {
    for (const diet of ENFORCED_DIETS) expect(DIETS).toContain(diet);
  });

  it("keeps the skill and leftovers lists in step with identity.ts", () => {
    expect([...SKILLS]).toEqual([...SKILL_LEVELS]);
    expect([...LEFTOVERS]).toEqual([...LEFTOVER_STANCES]);
  });
});

describe("ProfilePreferences with the WS06 vocabularies", () => {
  it("rejects dinners_per_week above 7 (acceptance criterion 1)", () => {
    expect(ProfilePreferences.safeParse({ dinners_per_week: 9 }).success).toBe(false);
    expect(ProfilePreferences.safeParse({ dinners_per_week: 0 }).success).toBe(false);
    expect(ProfilePreferences.safeParse({ dinners_per_week: 7 }).success).toBe(true);
  });

  it("rejects an allergen that is not in the list, so a typo cannot filter nothing", () => {
    expect(ProfilePreferences.safeParse({ allergies: ["shellfsh"] }).success).toBe(false);
    expect(ProfilePreferences.safeParse({ allergies: ["peanuts"] }).success).toBe(false);
    expect(ProfilePreferences.safeParse({ allergies: ["Peanut"] }).success).toBe(false);
    expect(ProfilePreferences.safeParse({ allergies: [...ALLERGENS] }).success).toBe(true);
  });

  it("rejects an unknown diet", () => {
    expect(ProfilePreferences.safeParse({ diets: ["carnivore"] }).success).toBe(false);
    expect(ProfilePreferences.safeParse({ diets: [...DIETS] }).success).toBe(true);
  });

  it("accepts the defaults (acceptance criterion 1)", () => {
    const defaults = defaultPreferences();
    expect(ProfilePreferences.safeParse(defaults).success).toBe(true);
    expect(ProfilePreferences.parse(defaults)).toEqual(defaults);
  });

  it("hands out a fresh object each time", () => {
    const a = defaultPreferences();
    a.allergies?.push("milk");
    expect(defaultPreferences().allergies).toEqual([]);
  });

  it("still lets unknown keys through", () => {
    expect(ProfilePreferences.parse({ allergies: ["milk"], future_key: 1 })).toEqual({
      allergies: ["milk"],
      future_key: 1,
    });
  });
});

describe("Diet and Allergen enums", () => {
  it("parse their own members and nothing else", () => {
    for (const diet of DIETS) expect(Diet.parse(diet)).toBe(diet);
    for (const allergen of ALLERGENS) expect(Allergen.parse(allergen)).toBe(allergen);
    expect(Diet.safeParse("vegetarian ").success).toBe(false);
    expect(Allergen.safeParse("nuts").success).toBe(false);
  });
});

describe("onboarding steps", () => {
  it("has eight steps numbered 1 to 8 with the route names from the brief", () => {
    expect(ONBOARDING_STEP_COUNT).toBe(8);
    expect(ONBOARDING_STEPS.map((s) => s.step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(ONBOARDING_STEPS.map((s) => s.route)).toEqual([
      "01-household",
      "02-eaters",
      "03-diets-allergies",
      "04-dislikes-cuisines",
      "05-time-skill",
      "06-budget-leftovers",
      "07-stores",
      "08-calibrate",
    ]);
  });

  it("resumes on the screen after the last completed one (acceptance criterion 3)", () => {
    expect(nextOnboardingStep(0)?.route).toBe("01-household");
    expect(nextOnboardingStep(null)?.route).toBe("01-household");
    expect(nextOnboardingStep(undefined)?.route).toBe("01-household");
    // Quitting on screen 5 leaves onboarding_step = 4.
    expect(nextOnboardingStep(4)?.route).toBe("05-time-skill");
    expect(nextOnboardingStep(7)?.route).toBe("08-calibrate");
  });

  it("is done at 8 and never strands anyone on a bad value", () => {
    expect(nextOnboardingStep(8)).toBeNull();
    expect(nextOnboardingStep(12)).toBeNull();
    expect(nextOnboardingStep(-3)?.route).toBe("01-household");
    expect(nextOnboardingStep(2.7)?.route).toBe("03-diets-allergies");
    expect(isOnboardingComplete(8)).toBe(true);
    expect(isOnboardingComplete(7)).toBe(false);
    expect(isOnboardingComplete(null)).toBe(false);
  });
});

describe("screen 1: household name", () => {
  it("takes 2 to 40 characters after trimming", () => {
    expect(HouseholdNameInput.safeParse({ name: "A" }).success).toBe(false);
    expect(HouseholdNameInput.safeParse({ name: "  A " }).success).toBe(false);
    expect(HouseholdNameInput.parse({ name: "  Our kitchen " }).name).toBe("Our kitchen");
    expect(HouseholdNameInput.safeParse({ name: "x".repeat(40) }).success).toBe(true);
    expect(HouseholdNameInput.safeParse({ name: "x".repeat(41) }).success).toBe(false);
  });
});

describe("screen 2: eaters", () => {
  it("needs an adult and 1 to 7 dinners", () => {
    expect(EatersInput.safeParse({ adults: 0, kids: 2, dinners_per_week: 5 }).success).toBe(false);
    expect(EatersInput.safeParse({ adults: 2, kids: -1, dinners_per_week: 5 }).success).toBe(false);
    expect(EatersInput.safeParse({ adults: 2, kids: 0, dinners_per_week: 0 }).success).toBe(false);
    expect(EatersInput.safeParse({ adults: 2, kids: 0, dinners_per_week: 8 }).success).toBe(false);
    expect(EatersInput.safeParse({ adults: 2.5, kids: 0, dinners_per_week: 5 }).success).toBe(
      false,
    );
    expect(EatersInput.safeParse({ adults: 1, kids: 0, dinners_per_week: 7 }).success).toBe(true);
  });

  it("writes household_size, dinners_per_week, and portions", () => {
    const prefs = eatersToPreferences({ adults: 2, kids: 2, dinners_per_week: 5 });
    expect(prefs).toEqual({
      household_size: { adults: 2, kids: 2 },
      dinners_per_week: 5,
      portions: 4,
    });
    expect(ProfilePreferences.safeParse(prefs).success).toBe(true);
  });
});

describe("screen 3: diets and allergies (acceptance criterion 4)", () => {
  it("cannot continue with no allergen choice", () => {
    const result = DietsAllergiesInput.safeParse({ diets: [], allergies: [], noAllergies: false });
    expect(result.success).toBe(false);
  });

  it("accepts an explicit None", () => {
    const result = DietsAllergiesInput.safeParse({ diets: [], allergies: [], noAllergies: true });
    expect(result.success).toBe(true);
  });

  it("accepts a list of allergens", () => {
    const result = DietsAllergiesInput.safeParse({
      diets: ["vegetarian"],
      allergies: ["shellfish", "sesame"],
      noAllergies: false,
    });
    expect(result.success).toBe(true);
  });

  it("refuses allergens together with None", () => {
    const result = DietsAllergiesInput.safeParse({
      diets: [],
      allergies: ["milk"],
      noAllergies: true,
    });
    expect(result.success).toBe(false);
  });

  it("refuses an allergen outside the list", () => {
    const result = DietsAllergiesInput.safeParse({
      diets: [],
      allergies: ["gluten"],
      noAllergies: false,
    });
    expect(result.success).toBe(false);
  });
});

describe("screen 4: dislikes and cuisines", () => {
  it("lowercases, trims, and de-duplicates never-foods", () => {
    const parsed = DislikesCuisinesInput.parse({
      dislikes: ["  Cilantro ", "cilantro", "Blue  Cheese"],
      cuisines: ["Thai", "thai"],
    });
    expect(parsed.dislikes).toEqual(["cilantro", "blue cheese"]);
    expect(parsed.cuisines).toEqual(["thai"]);
  });

  it("allows up to 20 never-foods", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `food ${i}`);
    expect(DislikesCuisinesInput.safeParse({ dislikes: twenty, cuisines: [] }).success).toBe(true);
    expect(
      DislikesCuisinesInput.safeParse({ dislikes: [...twenty, "one more"], cuisines: [] }).success,
    ).toBe(false);
  });

  it("rejects empty and very long entries", () => {
    expect(DislikesCuisinesInput.safeParse({ dislikes: ["  "], cuisines: [] }).success).toBe(false);
    expect(
      DislikesCuisinesInput.safeParse({ dislikes: ["x".repeat(61)], cuisines: [] }).success,
    ).toBe(false);
  });
});

describe("screen 5: time and skill", () => {
  it("keeps weeknight minutes between 10 and 120", () => {
    const base = { skill: "comfortable", equipment: [] };
    expect(TimeSkillInput.safeParse({ ...base, weeknight_minutes: 9 }).success).toBe(false);
    expect(TimeSkillInput.safeParse({ ...base, weeknight_minutes: 10 }).success).toBe(true);
    expect(TimeSkillInput.safeParse({ ...base, weeknight_minutes: 120 }).success).toBe(true);
    expect(TimeSkillInput.safeParse({ ...base, weeknight_minutes: 121 }).success).toBe(false);
    expect(TimeSkillInput.safeParse({ ...base, weeknight_minutes: 30.5 }).success).toBe(false);
  });

  it("needs a known skill", () => {
    expect(
      TimeSkillInput.safeParse({ weeknight_minutes: 30, skill: "expert", equipment: [] }).success,
    ).toBe(false);
  });
});

describe("screen 6: budget and leftovers", () => {
  it("takes null or 20 to 1000", () => {
    const base = { leftovers: "ok" };
    expect(BudgetLeftoversInput.safeParse({ ...base, budget_per_week_usd: null }).success).toBe(
      true,
    );
    expect(BudgetLeftoversInput.safeParse({ ...base, budget_per_week_usd: 19 }).success).toBe(
      false,
    );
    expect(BudgetLeftoversInput.safeParse({ ...base, budget_per_week_usd: 20 }).success).toBe(true);
    expect(BudgetLeftoversInput.safeParse({ ...base, budget_per_week_usd: 1000 }).success).toBe(
      true,
    );
    expect(BudgetLeftoversInput.safeParse({ ...base, budget_per_week_usd: 1001 }).success).toBe(
      false,
    );
  });

  it("leaves the budget out when the person skips it, and clears an earlier amount", () => {
    const skipped = budgetLeftoversToPreferences({
      budget_per_week_usd: null,
      leftovers: "prefer",
    });
    expect(skipped).toEqual({ leftovers: "prefer" });
    expect(skipped.budget_per_week_usd).toBeUndefined();
    // Merged over an earlier answer, the skipped budget and note are removed, not kept.
    const merged = mergePreferences(
      { budget_per_week_usd: 120, notes: "old", leftovers: "ok" },
      skipped,
    );
    expect(merged).toEqual({ leftovers: "prefer" });
    expect("budget_per_week_usd" in merged).toBe(false);
    const set = budgetLeftoversToPreferences({
      budget_per_week_usd: 150,
      leftovers: "ok",
      notes: "Kid hates mushrooms",
    });
    expect(set).toEqual({
      budget_per_week_usd: 150,
      leftovers: "ok",
      notes: "Kid hates mushrooms",
    });
  });

  it("caps the note", () => {
    expect(
      BudgetLeftoversInput.safeParse({
        budget_per_week_usd: null,
        leftovers: "ok",
        notes: "x".repeat(501),
      }).success,
    ).toBe(false);
  });
});

describe("screen 7: stores", () => {
  const valid = { zip: "98019", primary_store_id: "70100123", costco_member: false };

  it("needs a 5 digit ZIP, a store, and the Costco answer", () => {
    expect(StoresInput.safeParse(valid).success).toBe(true);
    expect(StoresInput.safeParse({ ...valid, zip: "9801" }).success).toBe(false);
    expect(StoresInput.safeParse({ ...valid, zip: "98019-1234" }).success).toBe(false);
    expect(StoresInput.safeParse({ ...valid, primary_store_id: "  " }).success).toBe(false);
    expect(StoresInput.safeParse({ zip: "98019", primary_store_id: "x" }).success).toBe(false);
  });
});

describe("mergePreferences", () => {
  it("keeps keys the screen does not write", () => {
    const merged = mergePreferences(
      { allergies: ["milk"], leftovers: "ok" },
      { leftovers: "prefer" },
    );
    expect(merged).toEqual({ allergies: ["milk"], leftovers: "prefer" });
  });

  it("removes a key set to undefined", () => {
    const merged = mergePreferences(
      { budget_per_week_usd: 100, leftovers: "ok" },
      {
        budget_per_week_usd: undefined,
      },
    );
    expect(merged).toEqual({ leftovers: "ok" });
  });

  it("starts from nothing", () => {
    expect(mergePreferences(null, { dinners_per_week: 4 })).toEqual({ dinners_per_week: 4 });
  });

  it("does not change its inputs", () => {
    const current = { allergies: ["milk" as const] };
    mergePreferences(current, { allergies: ["egg"] });
    expect(current).toEqual({ allergies: ["milk"] });
  });

  it("builds a complete valid preferences object screen by screen", () => {
    let prefs = mergePreferences(
      null,
      eatersToPreferences({ adults: 2, kids: 1, dinners_per_week: 5 }),
    );
    prefs = mergePreferences(prefs, { diets: [], allergies: ["shellfish"] });
    prefs = mergePreferences(prefs, { dislikes: ["cilantro"], cuisines: ["thai"] });
    prefs = mergePreferences(prefs, {
      weeknight_minutes: 40,
      skill: "comfortable",
      equipment: ["oven"],
    });
    prefs = mergePreferences(
      prefs,
      budgetLeftoversToPreferences({
        budget_per_week_usd: null,
        leftovers: "ok",
      }),
    );
    prefs = mergePreferences(prefs, { primary_store_id: "70100123" });
    expect(ProfilePreferences.safeParse(prefs).success).toBe(true);
    expect(prefs.allergies).toEqual(["shellfish"]);
    expect("budget_per_week_usd" in prefs).toBe(false);
  });
});

describe("comingWeekStart", () => {
  it("is today on a Monday", () => {
    expect(comingWeekStart(new Date(2026, 10, 2, 9, 0))).toBe("2026-11-02");
  });

  it("is the next Monday on any other day", () => {
    // 2026-10-30 is a Friday; the brief's example week starts 2026-11-02.
    expect(comingWeekStart(new Date(2026, 9, 30, 18, 0))).toBe("2026-11-02");
    expect(comingWeekStart(new Date(2026, 10, 1, 23, 59))).toBe("2026-11-02"); // Sunday
    expect(comingWeekStart(new Date(2026, 10, 3, 0, 1))).toBe("2026-11-09"); // Tuesday
  });

  it("crosses a month and a year", () => {
    expect(comingWeekStart(new Date(2026, 11, 30))).toBe("2027-01-04");
  });
});

describe("suggest contract", () => {
  it("parses the request from the brief", () => {
    const body = { householdId: HOUSEHOLD, weekStart: "2026-11-02", mode: "draft" };
    expect(SuggestRequest.parse(body)).toEqual(body);
    expect(SuggestRequest.safeParse({ ...body, mode: "other" }).success).toBe(false);
    expect(SuggestRequest.safeParse({ ...body, weekStart: "11/02/2026" }).success).toBe(false);
    expect(SuggestRequest.safeParse({ ...body, dinners: 8 }).success).toBe(false);
    expect(SuggestRequest.safeParse({ ...body, householdId: "nope" }).success).toBe(false);
  });

  it("takes a swap request with a date, a slot, and recipes to avoid", () => {
    const body = {
      householdId: HOUSEHOLD,
      weekStart: "2026-11-02",
      mode: "swap",
      date: "2026-11-04",
      slot: "dinner",
      excludeRecipeIds: [RECIPE],
    };
    expect(SuggestRequest.parse(body)).toEqual(body);
    expect(SuggestRequest.safeParse({ ...body, excludeRecipeIds: undefined }).success).toBe(true);
    expect(SuggestRequest.safeParse({ ...body, date: undefined }).success).toBe(false);
    expect(SuggestRequest.safeParse({ ...body, slot: undefined }).success).toBe(false);
    expect(SuggestRequest.safeParse({ ...body, slot: "brunch" }).success).toBe(false);
    expect(SuggestRequest.safeParse({ ...body, excludeRecipeIds: ["nope"] }).success).toBe(false);
    const tooMany = Array.from({ length: SWAP_EXCLUDE_MAX + 1 }, () => RECIPE);
    expect(SuggestRequest.safeParse({ ...body, excludeRecipeIds: tooMany }).success).toBe(false);
  });

  it("does not ask the other modes for a slot", () => {
    const body = { householdId: HOUSEHOLD, weekStart: "2026-11-02", mode: "draft" };
    expect(SuggestRequest.safeParse(body).success).toBe(true);
  });

  it("answers a swap with exactly one entry for any slot", () => {
    const entry = {
      date: "2026-11-04",
      slot: "lunch",
      recipeId: RECIPE,
      servings: 2,
      why: "Quick.",
    };
    expect(SuggestSwapResponse.safeParse({ ok: true, entries: [entry] }).success).toBe(true);
    expect(
      SuggestSwapResponse.safeParse({ ok: true, planId: HOUSEHOLD, entries: [entry] }).success,
    ).toBe(true);
    expect(SuggestSwapResponse.safeParse({ ok: true, entries: [] }).success).toBe(false);
    expect(SuggestSwapResponse.safeParse({ ok: true, entries: [entry, entry] }).success).toBe(
      false,
    );
  });

  it("lets a plan response say what a re-check changed, and stays valid without it", () => {
    const base = {
      ok: true,
      planId: HOUSEHOLD,
      entries: [{ date: "2026-11-02", slot: "dinner", recipeId: RECIPE, servings: 4, why: "" }],
      composedBy: "existing",
    };
    expect(SuggestPlanResponse.safeParse(base).success).toBe(true);
    const withRepair = SuggestPlanResponse.parse({
      ...base,
      repaired: { replaced: 1, removed: 2 },
    });
    expect(withRepair.repaired).toEqual({ replaced: 1, removed: 2 });
    expect(
      SuggestPlanResponse.safeParse({ ...base, repaired: { replaced: -1, removed: 0 } }).success,
    ).toBe(false);
  });

  it("holds a why to 139 characters", () => {
    const entry = { date: "2026-11-02", slot: "dinner", recipeId: RECIPE, servings: 4 };
    expect(SuggestEntry.safeParse({ ...entry, why: "x".repeat(WHY_MAX_CHARS) }).success).toBe(true);
    expect(SuggestEntry.safeParse({ ...entry, why: "x".repeat(WHY_MAX_CHARS + 1) }).success).toBe(
      false,
    );
    expect(SuggestEntry.safeParse({ ...entry, why: "" }).success).toBe(true);
  });

  it("returns at most twelve calibration cards", () => {
    expect(CALIBRATION_CARD_COUNT).toBe(12);
    const card = {
      recipeId: RECIPE,
      title: "Sheet pan chicken",
      description: null,
      imageUrl: null,
      sourceUrl: null,
      cuisine: null,
      totalMin: 35,
      tags: [],
    };
    const ok = SuggestCalibrationResponse.safeParse({
      ok: true,
      recipeIds: [RECIPE],
      cards: [card],
    });
    expect(ok.success).toBe(true);
    const tooMany = SuggestCalibrationResponse.safeParse({
      ok: true,
      recipeIds: Array.from({ length: 13 }, () => RECIPE),
      cards: Array.from({ length: 13 }, () => card),
    });
    expect(tooMany.success).toBe(false);
  });

  it("words every error for the person using the app, without em dashes", () => {
    for (const code of SUGGEST_ERROR_CODES) {
      const message = SUGGEST_ERROR_MESSAGES[code];
      expect(message.length).toBeGreaterThan(5);
      expect(message).not.toContain("—");
    }
  });
});
