import { MEAL_SLOTS, slotsForMode } from "@mp/core";
import { describe, expect, it } from "vitest";
import { byDay, planEntry } from "../../testing/planEntries";
import { MORE_MEALS_LABEL, moreMealsOf } from "./mode";

const DAY = "2026-11-03";
const breakfast = planEntry("b1", DAY, "breakfast", "Oatmeal");
const lunch = planEntry("l1", DAY, "lunch", "Leftover soup");
const lunch2 = planEntry("l2", DAY, "lunch", "Salad", { position: 1 });
const dinner = planEntry("d1", DAY, "dinner", "Lemon chicken");
const snack = planEntry("s1", DAY, "snack", "Apple slices");

const day = byDay([snack, dinner, lunch2, lunch, breakfast])[DAY];

describe("moreMealsOf", () => {
  it("in Just dinners mode returns every meal outside dinner, in the order a day reads", () => {
    expect(moreMealsOf(day, "simple").map((entry) => entry.id)).toEqual(["b1", "l1", "l2", "s1"]);
  });

  it("never returns the dinner", () => {
    expect(moreMealsOf(day, "simple").some((entry) => entry.slot === "dinner")).toBe(false);
  });

  it("in Every meal mode returns nothing, because every slot has its own cell", () => {
    expect(moreMealsOf(day, "full")).toEqual([]);
  });

  it("returns nothing for a day with only dinners, or no day at all", () => {
    expect(moreMealsOf(byDay([dinner])[DAY], "simple")).toEqual([]);
    expect(moreMealsOf(undefined, "simple")).toEqual([]);
    expect(moreMealsOf({}, "simple")).toEqual([]);
  });

  it("keeps position order within a slot", () => {
    const flipped = byDay([
      planEntry("l2", DAY, "lunch", "Salad", { position: 0 }),
      planEntry("l1", DAY, "lunch", "Leftover soup", { position: 1 }),
    ])[DAY];
    expect(moreMealsOf(flipped, "simple").map((entry) => entry.id)).toEqual(["l2", "l1"]);
  });

  it("together with the mode's own slots, accounts for every slot exactly once", () => {
    const covered = [...slotsForMode("simple")];
    for (const slot of MEAL_SLOTS) {
      const hidden = moreMealsOf(byDay([planEntry("x", DAY, slot, "Meal")])[DAY], "simple");
      expect(hidden.length === 1).toBe(!covered.includes(slot));
    }
  });
});

describe("copy", () => {
  it("has no em dash", () => {
    expect(MORE_MEALS_LABEL).toBe("More meals");
    expect(MORE_MEALS_LABEL).not.toContain(String.fromCharCode(0x2014));
  });
});
