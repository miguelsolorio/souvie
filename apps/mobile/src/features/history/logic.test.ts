import type { CookedMeal, MealsCookedWeek, SpendWeekRow } from "@mp/core";
import { describe, expect, it } from "vitest";
import {
  agoLabel,
  allCookedDates,
  canConfirm,
  cookedByDay,
  groupSpend,
  PROMPT_AFTER_HOURS,
  PROMPT_UNTIL_DAYS,
  pickPromptRun,
  spendForWeek,
  summarizeCooked,
  totalSpend,
} from "./logic";

const HOUSEHOLD = "0a000000-0000-4000-8000-00000000000a";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const spend = (over: Partial<SpendWeekRow> = {}): SpendWeekRow => ({
  household_id: HOUSEHOLD,
  week_start: "2026-11-02",
  retailer: "kroger",
  store_name: "Mock QFC Duvall",
  total_usd: 100,
  order_count: 1,
  ...over,
});

describe("groupSpend", () => {
  const rows = [
    spend({
      week_start: "2026-11-02",
      store_name: "Mock QFC Redmond",
      total_usd: 65.5,
      order_count: 2,
    }),
    spend({ week_start: "2026-11-09", total_usd: 80.25 }),
    spend({ week_start: "2026-11-02", total_usd: 100 }),
  ];

  it("groups by week, newest first, with each week's total and order count", () => {
    const weeks = groupSpend(rows);
    expect(weeks.map((w) => w.weekStart)).toEqual(["2026-11-09", "2026-11-02"]);
    expect(weeks[0]).toMatchObject({ total: 80.25, orders: 1 });
    expect(weeks[1]).toMatchObject({ total: 165.5, orders: 3 });
  });

  it("puts the biggest store first inside a week", () => {
    const week = groupSpend(rows)[1];
    expect(week?.stores.map((s) => s.label)).toEqual(["Mock QFC Duvall", "Mock QFC Redmond"]);
  });

  it("scales every bar against the largest store-week shown", () => {
    const weeks = groupSpend(rows);
    const shares = weeks.flatMap((w) => w.stores.map((s) => s.share));
    expect(Math.max(...shares)).toBe(1);
    expect(weeks[1]?.stores[1]?.share).toBeCloseTo(0.655, 5);
    expect(weeks[0]?.stores[0]?.share).toBeCloseTo(0.8025, 5);
  });

  it("gives the same store the same key in every week, and falls back to the retailer name", () => {
    const weeks = groupSpend(rows);
    const duvall = weeks.flatMap((w) => w.stores).filter((s) => s.label === "Mock QFC Duvall");
    expect(new Set(duvall.map((s) => s.key)).size).toBe(1);
    const unnamed = groupSpend([spend({ store_name: null })]);
    expect(unnamed[0]?.stores[0]?.label).toBe("Kroger");
  });

  it("adds cents without floating-point drift", () => {
    const sums = groupSpend([
      spend({ store_name: "A", total_usd: 0.1 }),
      spend({ store_name: "B", total_usd: 0.2 }),
    ]);
    expect(sums[0]?.total).toBe(0.3);
  });

  it("is empty for no rows and has zero-width bars if every total is zero", () => {
    expect(groupSpend([])).toEqual([]);
    expect(groupSpend([spend({ total_usd: 0 })])[0]?.stores[0]?.share).toBe(0);
  });
});

describe("totalSpend and spendForWeek", () => {
  it("sum to the cent", () => {
    const rows = [
      spend({ total_usd: 100 }),
      spend({ total_usd: 65.5 }),
      spend({ week_start: "2026-11-09", total_usd: 80.25 }),
    ];
    expect(totalSpend(rows)).toBe(245.75);
    expect(spendForWeek(rows, "2026-11-02")).toBe(165.5);
    expect(spendForWeek(rows, "2026-10-26")).toBe(0);
    expect(totalSpend([])).toBe(0);
  });
});

const meal = (n: number, date: string, over: Partial<CookedMeal> = {}): CookedMeal => ({
  id: uuid(n),
  date,
  slot: "dinner",
  recipe_id: uuid(100 + n),
  title: `Meal ${n}`,
  ...over,
});

const week = (weekStart: string, entries: CookedMeal[]): MealsCookedWeek => ({
  household_id: HOUSEHOLD,
  week_start: weekStart,
  cooked_count: entries.length,
  entries,
});

describe("cookedByDay", () => {
  it("groups a week's cooked meals by date, oldest day first, keeping the order within a day", () => {
    const days = cookedByDay([
      meal(1, "2026-11-04"),
      meal(2, "2026-11-02", { slot: "lunch" }),
      meal(3, "2026-11-02", { slot: "dinner" }),
    ]);
    expect(days.map((d) => d.date)).toEqual(["2026-11-02", "2026-11-04"]);
    expect(days[0]?.meals.map((m) => m.title)).toEqual(["Meal 2", "Meal 3"]);
  });

  it("is empty for a week with nothing", () => {
    expect(cookedByDay([])).toEqual([]);
  });
});

describe("summarizeCooked", () => {
  const weeks = [
    week("2026-11-02", [meal(1, "2026-11-02"), meal(2, "2026-11-03"), meal(3, "2026-11-04")]),
    week("2026-10-26", [meal(4, "2026-10-30"), meal(5, "2026-11-01")]),
  ];

  it("counts this week, every week loaded, and the streak ending today", () => {
    // Nov 4, 3, 2 and Sunday Nov 1 are in a row; Oct 31 is not cooked.
    expect(summarizeCooked(weeks, "2026-11-04")).toEqual({ thisWeek: 3, total: 5, streak: 4 });
  });

  it("keeps the streak going through the weekend into the next week", () => {
    const next = [week("2026-11-09", [meal(6, "2026-11-09")]), ...weeks];
    // Cooked Oct 30 (Fri), Nov 1 (Sun), Nov 2 to 4 and Nov 9: the gap on Nov 5 to 8 ends it.
    expect(summarizeCooked(next, "2026-11-09").streak).toBe(1);
  });

  it("counts a streak from yesterday when nothing is cooked yet today", () => {
    expect(summarizeCooked(weeks, "2026-11-05")).toMatchObject({ thisWeek: 3, streak: 4 });
  });

  it("is zero for no weeks", () => {
    expect(summarizeCooked([], "2026-11-04")).toEqual({ thisWeek: 0, total: 0, streak: 0 });
  });

  it("lists every date across the weeks", () => {
    expect(allCookedDates(weeks)).toHaveLength(5);
  });
});

describe("canConfirm", () => {
  it("is true only for an approved run whose cart is ready or checked out", () => {
    const approved = "2026-11-02T17:00:00Z";
    expect(canConfirm({ status: "cart_ready", approved_at: approved })).toBe(true);
    expect(canConfirm({ status: "checked_out", approved_at: approved })).toBe(true);
    expect(canConfirm({ status: "cart_ready", approved_at: null })).toBe(false);
    for (const status of [
      "queued",
      "running",
      "needs_review",
      "checking_out",
      "failed",
      "cancelled",
    ]) {
      expect(canConfirm({ status, approved_at: approved }), status).toBe(false);
    }
    expect(canConfirm(null)).toBe(false);
  });
});

describe("pickPromptRun", () => {
  const now = new Date("2026-11-03T20:00:00Z");
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();
  const run = (id: string, hours: number, over: Record<string, unknown> = {}) => ({
    id,
    status: "cart_ready",
    approved_at: hoursAgo(hours + 1),
    finished_at: hoursAgo(hours),
    ...over,
  });

  it("waits the two hours before it asks", () => {
    expect(PROMPT_AFTER_HOURS).toBe(2);
    expect(pickPromptRun([run("a", 1.9)], new Set(), [], now)).toBeNull();
    expect(pickPromptRun([run("a", 2)], new Set(), [], now)?.id).toBe("a");
  });

  it("stops asking after a week", () => {
    expect(PROMPT_UNTIL_DAYS).toBe(7);
    expect(pickPromptRun([run("a", 24 * 7)], new Set(), [], now)?.id).toBe("a");
    expect(pickPromptRun([run("a", 24 * 7 + 1)], new Set(), [], now)).toBeNull();
  });

  it("skips a run that has an order, was dismissed, or is not orderable", () => {
    const runs = [
      run("ordered", 3),
      run("dismissed", 4),
      run("queued", 5, { status: "queued" }),
      run("unapproved", 6, { approved_at: null }),
      run("no-finish", 7, { finished_at: null }),
    ];
    expect(pickPromptRun(runs, new Set(["ordered"]), ["dismissed"], now)).toBeNull();
  });

  it("picks the most recently finished of those left", () => {
    const runs = [run("old", 30), run("newer", 3), run("middle", 10)];
    expect(pickPromptRun(runs, new Set(), [], now)?.id).toBe("newer");
    expect(pickPromptRun(runs, new Set(["newer"]), [], now)?.id).toBe("middle");
  });

  it("is null for no runs", () => {
    expect(pickPromptRun([], new Set(), [], now)).toBeNull();
  });
});

describe("agoLabel", () => {
  const now = new Date("2026-11-03T20:00:00Z");
  it("says how long ago, rounded down", () => {
    expect(agoLabel("2026-11-03T19:30:00Z", now)).toBe("less than an hour ago");
    expect(agoLabel("2026-11-03T19:00:00Z", now)).toBe("1 hour ago");
    expect(agoLabel("2026-11-03T15:30:00Z", now)).toBe("4 hours ago");
    expect(agoLabel("2026-11-02T19:00:00Z", now)).toBe("1 day ago");
    expect(agoLabel("2026-10-30T20:00:00Z", now)).toBe("4 days ago");
  });
});
