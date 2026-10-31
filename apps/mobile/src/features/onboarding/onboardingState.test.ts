import { budgetLeftoversToPreferences, defaultPreferences, ProfilePreferences } from "@mp/core";
import { describe, expect, it } from "vitest";
import {
  buildProfileUpdate,
  draftFromPreferences,
  EDIT_RETURN_ROUTE,
  EDIT_START_HREF,
  EDIT_STEPS,
  guardOnboardingRoute,
  hasAnsweredAllergies,
  isEditParam,
  isEditStep,
  nextHref,
  OnboardingError,
  onboardingHref,
  parseBudgetText,
  previousHref,
  resumeHref,
  stepOfSegment,
  toggleItem,
} from "./onboardingState";

describe("routes", () => {
  it("builds hrefs without the group name", () => {
    expect(onboardingHref("02-eaters")).toBe("/02-eaters");
  });

  it("resumes on the screen after the last completed one (acceptance criterion 3)", () => {
    expect(resumeHref(0)).toBe("/01-household");
    expect(resumeHref(null)).toBe("/01-household");
    // Quitting on screen 5 leaves onboarding_step = 4.
    expect(resumeHref(4)).toBe("/05-time-skill");
    expect(resumeHref(7)).toBe("/08-calibrate");
    expect(resumeHref(8)).toBeNull();
  });

  it("walks forward and back through all eight screens", () => {
    expect(previousHref(1)).toBeNull();
    expect(previousHref(2)).toBe("/01-household");
    expect(nextHref(7)).toBe("/08-calibrate");
    expect(nextHref(8)).toBeNull();
  });

  it("reads the screen number from a route segment", () => {
    expect(stepOfSegment("03-diets-allergies")).toBe(3);
    expect(stepOfSegment("08-calibrate")).toBe(8);
    expect(stepOfSegment("_layout")).toBeNull();
    expect(stepOfSegment("recipes")).toBeNull();
    expect(stepOfSegment("09-extra")).toBeNull();
    expect(stepOfSegment(undefined)).toBeNull();
  });
});

describe("guardOnboardingRoute", () => {
  it("lets a person open the next screen and any earlier one", () => {
    expect(guardOnboardingRoute("05-time-skill", 4)).toBeNull();
    expect(guardOnboardingRoute("02-eaters", 4)).toBeNull();
    expect(guardOnboardingRoute("01-household", 0)).toBeNull();
  });

  it("does not let a typed URL skip ahead, so the allergy question cannot be bypassed", () => {
    expect(guardOnboardingRoute("07-stores", 2)).toBe("/03-diets-allergies");
    expect(guardOnboardingRoute("08-calibrate", 0)).toBe("/01-household");
    expect(guardOnboardingRoute("04-dislikes-cuisines", 2)).toBe("/03-diets-allergies");
  });

  it("sends everyone home once onboarding is done", () => {
    expect(guardOnboardingRoute("03-diets-allergies", 8)).toBe("/");
    expect(guardOnboardingRoute("07-stores", 8)).toBe("/");
    expect(guardOnboardingRoute(undefined, 8, "/plan")).toBe("/plan");
  });

  it("leaves the last screen open, so the person sees how the first plan went", () => {
    // The screen marks onboarding complete and then plans the week. Redirecting on that change
    // would hide a failed plan.
    expect(guardOnboardingRoute("08-calibrate", 8)).toBeNull();
    expect(guardOnboardingRoute("08-calibrate", 7)).toBeNull();
  });

  it("stays put for a segment that is not a screen", () => {
    expect(guardOnboardingRoute("_layout", 2)).toBeNull();
  });
});

describe("editing food preferences after onboarding (opened from household settings)", () => {
  it("lets a finished person reopen the food preference screens, and only those", () => {
    for (const screen of [
      "02-eaters",
      "03-diets-allergies",
      "04-dislikes-cuisines",
      "05-time-skill",
      "06-budget-leftovers",
    ]) {
      expect(guardOnboardingRoute(screen, 8, "/", true), screen).toBeNull();
      // Without ?edit=1 the same screen still sends them home.
      expect(guardOnboardingRoute(screen, 8, "/", false), screen).toBe("/");
    }
    for (const screen of ["01-household", "07-stores", "08-calibrate", "_layout", undefined]) {
      expect(guardOnboardingRoute(screen, 8, "/", true), String(screen)).toBe(EDIT_RETURN_ROUTE);
    }
  });

  it("ignores ?edit=1 for someone who has not finished: the normal rules apply", () => {
    expect(guardOnboardingRoute("07-stores", 2, "/", true)).toBe("/03-diets-allergies");
    expect(guardOnboardingRoute("03-diets-allergies", 2, "/", true)).toBeNull();
  });

  it("walks the five screens and then returns to settings", () => {
    expect(EDIT_STEPS).toEqual([2, 3, 4, 5, 6]);
    expect(EDIT_START_HREF).toBe("/02-eaters?edit=1");
    expect(nextHref(2, true)).toBe("/03-diets-allergies?edit=1");
    expect(nextHref(5, true)).toBe("/06-budget-leftovers?edit=1");
    // Continue on the last of them goes back to settings, not on to stores.
    expect(nextHref(6, true)).toBe(EDIT_RETURN_ROUTE);
    expect(previousHref(3, true)).toBe("/02-eaters?edit=1");
    // Back on the first of them goes back to settings, not to the household screen.
    expect(previousHref(2, true)).toBe(EDIT_RETURN_ROUTE);
  });

  it("leaves the normal walk alone", () => {
    expect(nextHref(6)).toBe("/07-stores");
    expect(previousHref(2)).toBe("/01-household");
  });

  it("reads only edit=1 as edit mode", () => {
    expect(isEditParam("1")).toBe(true);
    expect(isEditParam(["1"])).toBe(true);
    expect(isEditParam("0")).toBe(false);
    expect(isEditParam("true")).toBe(false);
    expect(isEditParam(undefined)).toBe(false);
    expect(isEditStep(4)).toBe(true);
    expect(isEditStep(7)).toBe(false);
  });
});

describe("buildProfileUpdate", () => {
  const stored = (preferences: ProfilePreferences, onboardingStep = 0) => ({
    preferences,
    onboardingStep,
    costcoMember: null,
  });

  it("merges one screen's keys into what is stored and sets the step", () => {
    const update = buildProfileUpdate(stored({ dinners_per_week: 4 }, 1), {
      step: 2,
      patch: { household_size: { adults: 2, kids: 1 }, portions: 3 },
    });
    expect(update).toEqual({
      preferences: { dinners_per_week: 4, household_size: { adults: 2, kids: 1 }, portions: 3 },
      onboarding_step: 2,
    });
  });

  it("never moves progress backward", () => {
    const update = buildProfileUpdate(stored({ allergies: ["milk"] }, 5), {
      step: 3,
      patch: { allergies: ["milk", "egg"], diets: [] },
    });
    expect(update.onboarding_step).toBe(5);
    expect(update.preferences.allergies).toEqual(["milk", "egg"]);
  });

  it("stores an empty allergy list as an answer, and never writes defaults on its own", () => {
    const empty = buildProfileUpdate(stored({}, 2), {
      step: 3,
      patch: { allergies: [], diets: [] },
    });
    expect(empty.preferences.allergies).toEqual([]);
    expect(hasAnsweredAllergies(empty.preferences)).toBe(true);
    const before = buildProfileUpdate(stored({}, 0), { step: 1 });
    expect(before.preferences).toEqual({});
    expect(hasAnsweredAllergies(before.preferences)).toBe(false);
  });

  it("refuses a patch that would make the preferences invalid", () => {
    expect(() =>
      buildProfileUpdate(stored({}), { step: 3, patch: { allergies: ["shellfsh"] } }),
    ).toThrow(OnboardingError);
    expect(() =>
      buildProfileUpdate(stored({}), { step: 2, patch: { dinners_per_week: 9 } }),
    ).toThrow(/dinners_per_week/);
  });

  it("removes a budget the person clears on a second pass", () => {
    const first = buildProfileUpdate(stored({}, 5), {
      step: 6,
      patch: budgetLeftoversToPreferences({ budget_per_week_usd: 150, leftovers: "ok" }),
    });
    expect(first.preferences.budget_per_week_usd).toBe(150);
    const second = buildProfileUpdate(stored(first.preferences, 6), {
      step: 6,
      patch: budgetLeftoversToPreferences({ budget_per_week_usd: null, leftovers: "ok" }),
    });
    expect("budget_per_week_usd" in second.preferences).toBe(false);
  });

  it("carries the Costco answer only when given", () => {
    expect(buildProfileUpdate(stored({}, 6), { step: 7, costcoMember: false }).costco_member).toBe(
      false,
    );
    expect("costco_member" in buildProfileUpdate(stored({}, 6), { step: 7 })).toBe(false);
  });

  it("needs a loaded profile and a real step", () => {
    expect(() => buildProfileUpdate(null, { step: 1 })).toThrow(/profile has not loaded/);
    expect(() => buildProfileUpdate(stored({}), { step: 0 })).toThrow(OnboardingError);
    expect(() => buildProfileUpdate(stored({}), { step: 9 })).toThrow(OnboardingError);
  });

  it("produces preferences the schema accepts after all eight screens (acceptance criterion 2)", () => {
    let current = stored({}, 0);
    const steps: [number, Partial<Record<string, unknown>>][] = [
      [1, {}],
      [2, { household_size: { adults: 2, kids: 1 }, dinners_per_week: 5, portions: 3 }],
      [3, { diets: ["vegetarian"], allergies: ["shellfish"] }],
      [4, { dislikes: ["cilantro"], cuisines: ["thai"] }],
      [5, { weeknight_minutes: 40, skill: "comfortable", equipment: ["oven"] }],
      [6, budgetLeftoversToPreferences({ budget_per_week_usd: null, leftovers: "prefer" })],
      [7, { primary_store_id: "safeway-98019-14020-main-st-ne" }],
      [8, {}],
    ];
    for (const [step, patch] of steps) {
      const update = buildProfileUpdate(current, { step, patch });
      current = {
        preferences: update.preferences,
        onboardingStep: update.onboarding_step,
        costcoMember: null,
      };
    }
    expect(current.onboardingStep).toBe(8);
    expect(ProfilePreferences.safeParse(current.preferences).success).toBe(true);
  });
});

describe("draftFromPreferences", () => {
  it("starts from the defaults and lets saved answers win", () => {
    const draft = draftFromPreferences({ dinners_per_week: 3, allergies: ["egg"] });
    expect(draft.dinners_per_week).toBe(3);
    expect(draft.allergies).toEqual(["egg"]);
    expect(draft.weeknight_minutes).toBe(defaultPreferences().weeknight_minutes);
    expect(draftFromPreferences(null)).toEqual(defaultPreferences());
  });
});

describe("parseBudgetText", () => {
  it("treats an empty box as skipped", () => {
    expect(parseBudgetText("")).toBeNull();
    expect(parseBudgetText("   ")).toBeNull();
  });

  it("reads plain amounts, with up to two decimals", () => {
    expect(parseBudgetText("150")).toBe(150);
    expect(parseBudgetText(" 99.50 ")).toBe(99.5);
  });

  it("returns NaN for anything else, so the schema refuses it", () => {
    for (const text of ["abc", "1.234", "1,000", "-5", "12e3", "1.", ".5"]) {
      expect(Number.isNaN(parseBudgetText(text)), text).toBe(true);
    }
  });
});

describe("toggleItem", () => {
  it("adds an item that is missing and removes one that is there", () => {
    expect(toggleItem(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleItem(["a", "b"], "a")).toEqual(["b"]);
    expect(toggleItem(undefined, "a")).toEqual(["a"]);
    expect(toggleItem(null, "a")).toEqual(["a"]);
  });

  it("does not change the list it was given", () => {
    const list = ["a"];
    toggleItem(list, "b");
    expect(list).toEqual(["a"]);
  });

  it("keeps both of two quick toggles when each starts from the latest list", () => {
    const afterFirst = toggleItem([] as string[], "slow cooker");
    expect(toggleItem(afterFirst, "oven")).toEqual(["slow cooker", "oven"]);
  });
});
