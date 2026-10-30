import { afterEach, describe, expect, it } from "vitest";
import {
  addDays,
  defaultServings,
  FALLBACK_SERVINGS,
  FEEDBACK_SIGNALS,
  FeedbackSignal,
  groupEntries,
  isIsoDate,
  isoDateOf,
  isWeekStart,
  MEAL_SLOTS,
  MealEntryStatus,
  MealPlan,
  MealPlanEntry,
  MealPlanEntryInput,
  MealPlanEntryPatch,
  MealSlot,
  mondayIndex,
  nextPosition,
  RecipeFeedback,
  shiftWeek,
  signalForStatus,
  sortEntries,
  weekDates,
  weekStartFor,
} from "./planning";

const ID_A = "a1111111-1111-4111-8111-111111111111";
const ID_B = "b2222222-2222-4222-8222-222222222222";
const ID_C = "c3333333-3333-4333-8333-333333333333";
const ID_D = "d4444444-4444-4444-8444-444444444444";
const NOW = "2026-10-30T07:12:14.123456+00:00";

// This package compiles without Node's types, so reach the environment through globalThis.
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } })
  .process.env;
const originalTz = env.TZ;
afterEach(() => {
  if (originalTz === undefined) delete env.TZ;
  else env.TZ = originalTz;
});

describe("weekStartFor on calendar dates", () => {
  it("returns the Monday on or before the date", () => {
    expect(weekStartFor("2026-11-02")).toBe("2026-11-02"); // a Monday maps to itself
    expect(weekStartFor("2026-11-03")).toBe("2026-11-02"); // Tuesday
    expect(weekStartFor("2026-11-08")).toBe("2026-11-02"); // Sunday belongs to the week before
    expect(weekStartFor("2026-11-09")).toBe("2026-11-09");
  });

  it("crosses a month boundary", () => {
    // Sunday 1 November 2026: its week began on Monday 26 October.
    expect(weekStartFor("2026-11-01")).toBe("2026-10-26");
    // Wednesday 1 July 2026: Monday was 29 June.
    expect(weekStartFor("2026-07-01")).toBe("2026-06-29");
    // Sunday 1 March 2026: Monday was 23 February.
    expect(weekStartFor("2026-03-01")).toBe("2026-02-23");
    // Sunday 31 May 2026 stays with Monday 25 May.
    expect(weekStartFor("2026-05-31")).toBe("2026-05-25");
  });

  it("crosses a year boundary", () => {
    expect(weekStartFor("2027-01-01")).toBe("2026-12-28"); // Friday
    expect(weekStartFor("2026-12-31")).toBe("2026-12-28");
    expect(weekStartFor("2024-12-31")).toBe("2024-12-30"); // Tuesday
    expect(weekStartFor("2023-01-01")).toBe("2022-12-26"); // Sunday
  });

  it("handles leap days", () => {
    expect(weekStartFor("2028-02-29")).toBe("2028-02-28"); // Tuesday
    expect(weekStartFor("2028-03-01")).toBe("2028-02-28"); // Wednesday
    expect(weekStartFor("2028-02-27")).toBe("2028-02-21"); // Sunday
  });

  it("is idempotent and always lands on a Monday", () => {
    let day = "2026-01-01";
    for (let i = 0; i < 800; i++) {
      const monday = weekStartFor(day);
      expect(isWeekStart(monday)).toBe(true);
      expect(weekStartFor(monday)).toBe(monday);
      const gap = (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${monday}T00:00:00Z`)) / 86_400_000;
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(gap).toBeLessThan(7);
      day = addDays(day, 1);
    }
  });

  it("rejects strings that are not calendar dates", () => {
    expect(() => weekStartFor("2026-02-30")).toThrow(RangeError);
    expect(() => weekStartFor("2026-13-01")).toThrow(RangeError);
    expect(() => weekStartFor("11/03/2026")).toThrow(RangeError);
    expect(() => weekStartFor("2026-11-03T10:00:00Z")).toThrow(RangeError);
    expect(() => weekStartFor("")).toThrow(RangeError);
  });
});

// Daylight saving: the US changes clocks on Sunday 8 March and Sunday 1 November 2026, Europe on
// Sunday 29 March and Sunday 25 October, New Zealand on Sunday 27 September. A week that holds a
// change is 23 or 25 hours long in one day; the week math must not notice.
describe("weekStartFor across daylight saving changes", () => {
  const cases: Array<{
    tz: string;
    label: string;
    at: [number, number, number, number, number];
    expected: string;
  }> = [
    {
      tz: "America/Los_Angeles",
      label: "US fall back, 01:30 on the Sunday the clocks go back",
      at: [2026, 10, 1, 1, 30],
      expected: "2026-10-26",
    },
    {
      tz: "America/Los_Angeles",
      label: "US fall back, 23:59 that Sunday",
      at: [2026, 10, 1, 23, 59],
      expected: "2026-10-26",
    },
    {
      tz: "America/Los_Angeles",
      label: "US fall back, 00:30 the Monday after",
      at: [2026, 10, 2, 0, 30],
      expected: "2026-11-02",
    },
    {
      tz: "America/Los_Angeles",
      label: "US spring forward, 03:30 on the Sunday the clocks go forward",
      at: [2026, 2, 8, 3, 30],
      expected: "2026-03-02",
    },
    {
      tz: "America/Los_Angeles",
      label: "US spring forward, 00:30 the Monday after",
      at: [2026, 2, 9, 0, 30],
      expected: "2026-03-09",
    },
    {
      tz: "Europe/London",
      label: "UK spring forward, Sunday 29 March 23:30",
      at: [2026, 2, 29, 23, 30],
      expected: "2026-03-23",
    },
    {
      tz: "Europe/London",
      label: "UK fall back, Monday 26 October 00:15",
      at: [2026, 9, 26, 0, 15],
      expected: "2026-10-26",
    },
    {
      tz: "Pacific/Auckland",
      label: "NZ spring forward, Monday 28 September 00:05",
      at: [2026, 8, 28, 0, 5],
      expected: "2026-09-28",
    },
    {
      tz: "Pacific/Kiritimati",
      label: "UTC+14, late Sunday local is still that Sunday",
      at: [2026, 10, 1, 23, 59],
      expected: "2026-10-26",
    },
    {
      tz: "Pacific/Pago_Pago",
      label: "UTC-11, early Monday local is already Monday",
      at: [2026, 10, 2, 0, 1],
      expected: "2026-11-02",
    },
  ];

  for (const { tz, label, at, expected } of cases) {
    it(`${tz}: ${label}`, () => {
      // Build the Date after switching zones, so its wall-clock fields are the ones written above.
      env.TZ = tz;
      const [y, m, d, h, min] = at;
      expect(weekStartFor(new Date(y, m, d, h, min))).toBe(expected);
    });
  }

  it("builds the same Date in the zone it is read in", () => {
    env.TZ = "America/Los_Angeles";
    const sundayNight = new Date(2026, 10, 1, 23, 30);
    expect(isoDateOf(sundayNight)).toBe("2026-11-01");
    expect(weekStartFor(sundayNight)).toBe("2026-10-26");
    env.TZ = "Asia/Tokyo";
    const mondayMorning = new Date(2026, 10, 2, 0, 30);
    expect(isoDateOf(mondayMorning)).toBe("2026-11-02");
    expect(weekStartFor(mondayMorning)).toBe("2026-11-02");
  });

  it("reads one instant as different weeks in different zones", () => {
    // 07:30 UTC on Monday 2 November is Sunday night in Los Angeles and Monday afternoon in Tokyo.
    const instant = new Date("2026-11-02T07:30:00Z");
    env.TZ = "America/Los_Angeles";
    expect(isoDateOf(instant)).toBe("2026-11-01");
    expect(weekStartFor(instant)).toBe("2026-10-26");
    env.TZ = "Asia/Tokyo";
    expect(isoDateOf(instant)).toBe("2026-11-02");
    expect(weekStartFor(instant)).toBe("2026-11-02");
  });

  it("lists seven distinct consecutive dates for the week that holds a clock change", () => {
    env.TZ = "America/Los_Angeles";
    expect(weekDates("2026-10-26")).toEqual([
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
    ]);
    // The spring week, 23 hours long on Sunday 8 March.
    expect(weekDates("2026-03-02")).toEqual([
      "2026-03-02",
      "2026-03-03",
      "2026-03-04",
      "2026-03-05",
      "2026-03-06",
      "2026-03-07",
      "2026-03-08",
    ]);
  });

  it("steps weeks across a clock change without drifting", () => {
    env.TZ = "America/Los_Angeles";
    let week = "2026-03-02";
    for (let i = 0; i < 60; i++) {
      expect(isWeekStart(week)).toBe(true);
      week = shiftWeek(week, 1);
    }
    expect(week).toBe("2027-04-26");
    expect(shiftWeek(week, -60)).toBe("2026-03-02");
  });
});

describe("date helpers", () => {
  it("adds days across month, year, and leap boundaries", () => {
    expect(addDays("2026-10-30", 3)).toBe("2026-11-02");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2027-02-28", 1)).toBe("2027-03-01");
    expect(addDays("2026-11-02", -1)).toBe("2026-11-01");
    expect(addDays("2026-11-02", 0)).toBe("2026-11-02");
  });

  it("numbers weekdays from Monday", () => {
    expect(mondayIndex("2026-11-02")).toBe(0);
    expect(mondayIndex("2026-11-03")).toBe(1);
    expect(mondayIndex("2026-11-08")).toBe(6);
  });

  it("recognizes real calendar dates only", () => {
    expect(isIsoDate("2026-02-28")).toBe(true);
    expect(isIsoDate("2028-02-29")).toBe(true);
    expect(isIsoDate("2026-02-29")).toBe(false);
    expect(isIsoDate("2026-4-1")).toBe(false);
    expect(isWeekStart("2026-11-02")).toBe(true);
    expect(isWeekStart("2026-11-03")).toBe(false);
    expect(isWeekStart("nope")).toBe(false);
  });

  it("lists a week from any day in it, Monday first", () => {
    const week = weekDates("2026-11-05");
    expect(week).toHaveLength(7);
    expect(week[0]).toBe("2026-11-02");
    expect(week[6]).toBe("2026-11-08");
  });

  it("shifts by whole weeks and snaps to Monday", () => {
    expect(shiftWeek("2026-11-02", 1)).toBe("2026-11-09");
    expect(shiftWeek("2026-11-02", -1)).toBe("2026-10-26");
    expect(shiftWeek("2026-11-05", 0)).toBe("2026-11-02");
    expect(shiftWeek("2026-12-28", 1)).toBe("2027-01-04");
  });
});

const entry = (over: Partial<MealPlanEntry> = {}): MealPlanEntry => ({
  id: ID_A,
  plan_id: ID_B,
  household_id: ID_C,
  date: "2026-11-03",
  slot: "dinner",
  recipe_id: ID_D,
  servings: 4,
  status: "planned",
  notes: null,
  position: 0,
  created_at: NOW,
  updated_at: NOW,
  ...over,
});

describe("MealSlot, MealEntryStatus, FeedbackSignal", () => {
  it("match the Postgres enums", () => {
    expect(MEAL_SLOTS).toEqual(["breakfast", "lunch", "dinner", "snack"]);
    expect(MealSlot.safeParse("brunch").success).toBe(false);
    expect(MealEntryStatus.options).toEqual(["planned", "cooked", "skipped"]);
    expect(FEEDBACK_SIGNALS).toEqual(["like", "dislike", "cooked", "skipped", "saved"]);
    expect(FeedbackSignal.safeParse("swapped").success).toBe(false);
  });
});

describe("MealPlan", () => {
  const plan = {
    id: ID_A,
    household_id: ID_B,
    week_start: "2026-11-02",
    created_at: NOW,
    updated_at: NOW,
  };

  it("parses a row as PostgREST returns it", () => {
    expect(MealPlan.parse(plan)).toEqual(plan);
  });

  it("rejects a week_start that is not a Monday or not a date", () => {
    expect(MealPlan.safeParse({ ...plan, week_start: "2026-11-03" }).success).toBe(false);
    expect(MealPlan.safeParse({ ...plan, week_start: "2026-02-30" }).success).toBe(false);
    expect(MealPlan.safeParse({ ...plan, week_start: "2026-11-02T00:00:00Z" }).success).toBe(false);
  });
});

describe("MealPlanEntry", () => {
  it("parses a row as PostgREST returns it", () => {
    expect(MealPlanEntry.parse(entry())).toEqual(entry());
  });

  it("accepts notes and fractional servings", () => {
    const parsed = MealPlanEntry.parse(entry({ notes: "double the sauce", servings: 2.5 }));
    expect(parsed.notes).toBe("double the sauce");
    expect(parsed.servings).toBe(2.5);
  });

  it("rejects values the database would reject", () => {
    expect(MealPlanEntry.safeParse(entry({ servings: 0 })).success).toBe(false);
    expect(MealPlanEntry.safeParse(entry({ servings: 1001 })).success).toBe(false);
    expect(MealPlanEntry.safeParse(entry({ position: -1 })).success).toBe(false);
    expect(MealPlanEntry.safeParse(entry({ notes: "x".repeat(1001) })).success).toBe(false);
    expect(MealPlanEntry.safeParse({ ...entry(), slot: "brunch" }).success).toBe(false);
    expect(MealPlanEntry.safeParse({ ...entry(), status: "done" }).success).toBe(false);
    expect(MealPlanEntry.safeParse({ ...entry(), date: "2026-11-31" }).success).toBe(false);
  });
});

describe("MealPlanEntryInput", () => {
  it("fills the defaults the database would", () => {
    const parsed = MealPlanEntryInput.parse({
      date: "2026-11-03",
      slot: "dinner",
      recipe_id: ID_D,
      servings: 4,
    });
    expect(parsed).toMatchObject({ status: "planned", notes: null, position: 0 });
  });

  it("is the example upsert payload from the brief, minus the ids", () => {
    const parsed = MealPlanEntryInput.parse({
      date: "2026-11-03",
      slot: "dinner",
      recipe_id: ID_D,
      servings: 4,
      status: "planned",
      position: 0,
    });
    expect(parsed.slot).toBe("dinner");
    expect(parsed.servings).toBe(4);
  });

  it("rejects zero servings and a bad slot", () => {
    const base = { date: "2026-11-03", slot: "dinner", recipe_id: ID_D, servings: 4 };
    expect(MealPlanEntryInput.safeParse({ ...base, servings: 0 }).success).toBe(false);
    expect(MealPlanEntryInput.safeParse({ ...base, slot: "dessert" }).success).toBe(false);
  });
});

describe("MealPlanEntryPatch", () => {
  it("accepts any subset of the editable columns and fills nothing in", () => {
    expect(MealPlanEntryPatch.parse({})).toEqual({});
    expect(MealPlanEntryPatch.parse({ servings: 6 })).toEqual({ servings: 6 });
    expect(MealPlanEntryPatch.parse({ status: "cooked", notes: null })).toEqual({
      status: "cooked",
      notes: null,
    });
  });

  it("validates what it is given", () => {
    expect(MealPlanEntryPatch.safeParse({ servings: 0 }).success).toBe(false);
    expect(MealPlanEntryPatch.safeParse({ slot: "brunch" }).success).toBe(false);
    expect(MealPlanEntryPatch.safeParse({ date: "2026-02-30" }).success).toBe(false);
  });
});

describe("RecipeFeedback", () => {
  const row = {
    id: ID_A,
    household_id: ID_B,
    user_id: ID_C,
    recipe_id: ID_D,
    signal: "like",
    rating: null,
    created_at: NOW,
  };

  it("parses a row", () => {
    expect(RecipeFeedback.parse(row)).toEqual(row);
    expect(RecipeFeedback.parse({ ...row, rating: 5 }).rating).toBe(5);
  });

  it("rejects a rating outside 1 to 5 and an unknown signal", () => {
    expect(RecipeFeedback.safeParse({ ...row, rating: 0 }).success).toBe(false);
    expect(RecipeFeedback.safeParse({ ...row, rating: 6 }).success).toBe(false);
    expect(RecipeFeedback.safeParse({ ...row, signal: "love" }).success).toBe(false);
  });
});

describe("groupEntries, sortEntries, nextPosition", () => {
  const dinner0 = entry({ id: ID_A, position: 0 });
  const dinner1 = entry({ id: ID_B, position: 1 });
  const lunch = entry({ id: ID_C, slot: "lunch" });
  const wed = entry({ id: ID_D, date: "2026-11-04" });

  it("groups by date then slot and orders by position", () => {
    const grouped = groupEntries([dinner1, wed, lunch, dinner0]);
    expect(Object.keys(grouped).sort()).toEqual(["2026-11-03", "2026-11-04"]);
    expect(grouped["2026-11-03"]?.dinner?.map((e) => e.id)).toEqual([ID_A, ID_B]);
    expect(grouped["2026-11-03"]?.lunch?.map((e) => e.id)).toEqual([ID_C]);
    expect(grouped["2026-11-03"]?.breakfast).toBeUndefined();
    expect(grouped["2026-11-04"]?.dinner?.map((e) => e.id)).toEqual([ID_D]);
  });

  it("breaks position ties by creation time, then id, so the order is stable", () => {
    const early = entry({ id: ID_B, created_at: "2026-10-30T07:00:00+00:00" });
    const late = entry({ id: ID_A, created_at: "2026-10-30T08:00:00+00:00" });
    expect(sortEntries([late, early]).map((e) => e.id)).toEqual([ID_B, ID_A]);
  });

  it("does not mutate its input", () => {
    const input = [dinner1, dinner0];
    sortEntries(input);
    expect(input.map((e) => e.id)).toEqual([ID_B, ID_A]);
  });

  it("puts a new entry after the last one in its slot", () => {
    const all = [dinner0, dinner1, lunch, wed];
    expect(nextPosition(all, "2026-11-03", "dinner")).toBe(2);
    expect(nextPosition(all, "2026-11-03", "lunch")).toBe(1);
    expect(nextPosition(all, "2026-11-03", "snack")).toBe(0);
    expect(nextPosition([], "2026-11-03", "dinner")).toBe(0);
  });
});

describe("defaultServings", () => {
  it("prefers the person's own portions", () => {
    expect(
      defaultServings({
        preferences: { portions: 3, household_size: { adults: 2, kids: 2 } },
        recipeServings: 8,
      }),
    ).toBe(3);
  });

  it("falls back to adults plus kids", () => {
    expect(
      defaultServings({
        preferences: { household_size: { adults: 2, kids: 2 } },
        recipeServings: 8,
      }),
    ).toBe(4);
    expect(
      defaultServings({
        preferences: { household_size: { adults: 1, kids: 0 } },
        recipeServings: 8,
      }),
    ).toBe(1);
  });

  it("falls back to the recipe's servings, then to four", () => {
    expect(defaultServings({ preferences: {}, recipeServings: 6 })).toBe(6);
    expect(defaultServings({ preferences: null, recipeServings: 6 })).toBe(6);
    expect(defaultServings({ preferences: {}, recipeServings: null })).toBe(FALLBACK_SERVINGS);
    expect(defaultServings({})).toBe(FALLBACK_SERVINGS);
    expect(defaultServings({ recipeServings: 0 })).toBe(FALLBACK_SERVINGS);
  });

  it("ignores a non-positive portions value and keeps the result in range", () => {
    expect(defaultServings({ preferences: { portions: 0 }, recipeServings: 5 })).toBe(5);
    expect(defaultServings({ recipeServings: 5000 })).toBe(1000);
    expect(defaultServings({ preferences: { portions: 0.1 } })).toBe(0.5);
  });
});

describe("signalForStatus", () => {
  it("maps cooked and skipped to their signals and planned to none", () => {
    expect(signalForStatus("cooked")).toBe("cooked");
    expect(signalForStatus("skipped")).toBe("skipped");
    expect(signalForStatus("planned")).toBeNull();
  });
});

describe("@mp/core exports the planning contracts", () => {
  it("through the package barrel", async () => {
    const mod = await import("./index");
    for (const name of [
      "MealPlan",
      "MealPlanEntry",
      "MealSlot",
      "RecipeFeedback",
      "weekStartFor",
      "weekDates",
      "defaultServings",
    ]) {
      expect(mod).toHaveProperty(name);
    }
  });
});
