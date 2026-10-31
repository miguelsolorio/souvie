import { describe, expect, it } from "vitest";
import { buildFilterSpec, FilterError, filterInputFromPreferences } from "./filters.ts";
import { readStoredPreferences } from "./store.ts";

describe("readStoredPreferences", () => {
  it("keeps allergies and diets when other fields are invalid (the reviewer's reproduction)", () => {
    const stored = readStoredPreferences({
      allergies: ["shellfish", "milk"],
      diets: ["vegetarian"],
      weeknight_minutes: 0,
      skill: "expert",
    });
    expect(stored.allergies).toEqual(["shellfish", "milk"]);
    expect(stored.diets).toEqual(["vegetarian"]);
    // Only the invalid fields are gone.
    expect(stored.weeknight_minutes).toBeUndefined();
    expect(stored.skill).toBeUndefined();
  });

  it("keeps every valid field next to an invalid one", () => {
    const stored = readStoredPreferences({
      allergies: [],
      dinners_per_week: 9,
      weeknight_minutes: 30,
      cuisines: ["thai"],
      portions: -2,
      notes: "We eat early.",
    });
    expect(stored).toEqual({
      allergies: [],
      weeknight_minutes: 30,
      cuisines: ["thai"],
      notes: "We eat early.",
    });
  });

  it("does not turn an unanswered allergy question into an answer", () => {
    expect(readStoredPreferences({ skill: "expert" }).allergies).toBeUndefined();
    expect(readStoredPreferences({ allergies: null }).allergies).toBeUndefined();
    expect(readStoredPreferences(null)).toEqual({});
    expect(readStoredPreferences("nonsense")).toEqual({});
    expect(readStoredPreferences([1, 2])).toEqual({});
  });

  it("an empty list stays an answer: no allergies", () => {
    expect(readStoredPreferences({ allergies: [], diets: [] })).toEqual({
      allergies: [],
      diets: [],
    });
  });

  it("fails closed on a value outside the vocabulary instead of dropping it", () => {
    const stored = readStoredPreferences({ allergies: ["shellfish", "gluten"] });
    expect(stored.allergies).toEqual(["shellfish", "gluten"]);
    expect(() => buildFilterSpec(filterInputFromPreferences(stored))).toThrowError(FilterError);
    const diet = readStoredPreferences({ diets: ["carnivore"] });
    expect(() => buildFilterSpec(filterInputFromPreferences(diet))).toThrowError(FilterError);
  });

  it("fails closed on allergies or diets that are not lists of strings", () => {
    expect(() => readStoredPreferences({ allergies: "milk" })).toThrowError(FilterError);
    expect(() => readStoredPreferences({ allergies: [1] })).toThrowError(FilterError);
    expect(() => readStoredPreferences({ diets: { vegan: true } })).toThrowError(FilterError);
  });

  it("puts a housemate's allergy into the household's union whatever else is wrong", () => {
    const me = readStoredPreferences({ allergies: ["shellfish"] });
    const mate = readStoredPreferences({ allergies: ["peanut"], weeknight_minutes: 0 });
    const input = filterInputFromPreferences(me, [mate]);
    expect([...input.allergies].sort()).toEqual(["peanut", "shellfish"]);
  });
});
