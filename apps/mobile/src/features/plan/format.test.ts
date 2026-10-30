import type { PlanEntry } from "@mp/db";
import { describe, expect, it } from "vitest";
import {
  dayName,
  entryA11yLabel,
  entryTitle,
  longDate,
  neighborDay,
  servingsLabel,
  shortDayName,
  shortMonthDay,
  slotTitle,
  weekRangeLabel,
} from "./format";

const recipe = {
  id: "r1",
  title: "Lemon chicken",
  image_url: null,
  servings: 4,
  prep_min: 10,
  cook_min: 30,
  deleted_at: null,
};

const entry = (over: Partial<PlanEntry> = {}): PlanEntry => ({
  id: "e1",
  plan_id: "p1",
  household_id: "h1",
  date: "2026-11-03",
  slot: "dinner",
  recipe_id: "r1",
  servings: 4,
  status: "planned",
  notes: null,
  position: 0,
  created_at: "2026-10-30T12:00:00.000Z",
  updated_at: "2026-10-30T12:00:00.000Z",
  recipe,
  ...over,
});

describe("day and date names", () => {
  it("names the weekday of a calendar date", () => {
    expect(dayName("2026-11-02")).toBe("Monday");
    expect(dayName("2026-11-03")).toBe("Tuesday");
    expect(dayName("2026-11-08")).toBe("Sunday");
    expect(shortDayName("2026-11-05")).toBe("Thu");
  });

  it("formats month and day", () => {
    expect(shortMonthDay("2026-11-03")).toBe("Nov 3");
    expect(shortMonthDay("2026-12-31")).toBe("Dec 31");
    expect(longDate("2026-11-03")).toBe("Tuesday, November 3");
    expect(longDate("2028-02-29")).toBe("Tuesday, February 29");
  });

  it("titles a slot", () => {
    expect(slotTitle("2026-11-03", "dinner")).toBe("Tuesday dinner");
    expect(slotTitle("2026-11-08", "snack")).toBe("Sunday snack");
  });

  it("steps a day", () => {
    expect(neighborDay("2026-11-30", 1)).toBe("2026-12-01");
    expect(neighborDay("2026-11-01", -1)).toBe("2026-10-31");
  });
});

describe("weekRangeLabel", () => {
  it("collapses a week inside one month", () => {
    expect(weekRangeLabel("2026-11-02")).toBe("Nov 2 to 8, 2026");
  });

  it("names both months across a month boundary", () => {
    expect(weekRangeLabel("2026-10-26")).toBe("Oct 26 to Nov 1, 2026");
    expect(weekRangeLabel("2026-06-29")).toBe("Jun 29 to Jul 5, 2026");
  });

  it("names both years across a year boundary", () => {
    expect(weekRangeLabel("2026-12-28")).toBe("Dec 28, 2026 to Jan 3, 2027");
  });

  it("snaps a mid-week date to its week", () => {
    expect(weekRangeLabel("2026-11-05")).toBe("Nov 2 to 8, 2026");
  });

  it("does not skip or repeat a day across the clock change in November", () => {
    expect(weekRangeLabel("2026-10-26")).toContain("Nov 1");
  });
});

describe("entry labels", () => {
  it("pluralizes servings", () => {
    expect(servingsLabel(1)).toBe("1 serving");
    expect(servingsLabel(4)).toBe("4 servings");
    expect(servingsLabel(2.5)).toBe("2.5 servings");
  });

  it("titles an entry by its recipe, and never leaves a hole", () => {
    expect(entryTitle(entry())).toBe("Lemon chicken");
    expect(entryTitle(entry({ recipe: null }))).toBe("Recipe unavailable");
    expect(entryTitle(entry({ recipe: { ...recipe, deleted_at: "2026-10-30T00:00:00Z" } }))).toBe(
      "Lemon chicken (deleted)",
    );
  });

  it("reads an entry aloud with its servings and any status", () => {
    expect(entryA11yLabel(entry())).toBe("Lemon chicken, 4 servings");
    expect(entryA11yLabel(entry({ status: "cooked" }))).toBe("Lemon chicken, 4 servings, cooked");
    expect(entryA11yLabel(entry({ status: "skipped", servings: 1 }))).toBe(
      "Lemon chicken, 1 serving, skipped",
    );
  });
});
