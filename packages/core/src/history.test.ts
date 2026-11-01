import { describe, expect, it } from "vitest";
import {
  ConfirmOrderInput,
  CookedMeal,
  canPin,
  cookedStreak,
  countsAsSpend,
  groupByWeek,
  HISTORY_LIMITS,
  MealsCookedWeek,
  MostBoughtRow,
  Order,
  OrderPatch,
  OrderStatus,
  orderWindowError,
  parseMoneyInput,
  recentWeeks,
  SpendWeekRow,
  weekStart,
} from "./history";
import { isoDateOf, weekStartFor } from "./planning";

const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const LA = "America/Los_Angeles";

describe("weekStart", () => {
  it("uses a calendar date as written, Monday to Sunday", () => {
    expect(weekStart("2026-11-02")).toBe("2026-11-02"); // Monday
    expect(weekStart("2026-11-03")).toBe("2026-11-02");
    expect(weekStart("2026-11-08")).toBe("2026-11-02"); // Sunday
    expect(weekStart("2026-11-09")).toBe("2026-11-09");
  });

  it("agrees with weekStartFor for a calendar date, in any zone", () => {
    for (const day of ["2026-01-01", "2026-02-28", "2026-12-31", "2027-01-03"]) {
      expect(weekStart(day, LA)).toBe(weekStartFor(day));
      expect(weekStart(day, "Pacific/Auckland")).toBe(weekStartFor(day));
    }
  });

  it("reads an instant in the zone it is given", () => {
    // Monday 04:00 in UTC is still Sunday evening in Los Angeles, so the previous week.
    expect(weekStart("2026-11-09T04:00:00+00:00", LA)).toBe("2026-11-02");
    expect(weekStart("2026-11-09T04:00:00+00:00", "UTC")).toBe("2026-11-09");
    expect(weekStart(new Date("2026-11-09T04:00:00Z"), LA)).toBe("2026-11-02");
    // The same instant is already Monday afternoon in Auckland.
    expect(weekStart("2026-11-08T23:00:00Z", "Pacific/Auckland")).toBe("2026-11-09");
  });

  it("keeps Sunday 23:59 in its week and starts the next at midnight, across the spring change", () => {
    // Daylight saving began at 02:00 on Sunday 2026-03-08 in Los Angeles.
    expect(weekStart("2026-03-09T06:59:00Z", LA)).toBe("2026-03-02"); // Sun 23:59 PDT
    expect(weekStart("2026-03-09T07:00:00Z", LA)).toBe("2026-03-09"); // Mon 00:00 PDT
  });

  it("keeps the boundary across the autumn change", () => {
    // It ended at 02:00 on Sunday 2026-11-01, so Sunday 2026-11-08 is already on PST.
    expect(weekStart("2026-11-09T07:59:00Z", LA)).toBe("2026-11-02"); // Sun 23:59 PST
    expect(weekStart("2026-11-09T08:00:00Z", LA)).toBe("2026-11-09"); // Mon 00:00 PST
  });

  it("reads an instant in the device's zone when no zone is given", () => {
    const instant = new Date(2026, 10, 8, 23, 30); // Sunday 23:30 on this device, whatever it is
    expect(weekStart(instant)).toBe(weekStartFor(isoDateOf(instant)));
    expect(weekStart(instant)).toBe("2026-11-02");
    const monday = new Date(2026, 10, 9, 0, 30);
    expect(weekStart(monday)).toBe("2026-11-09");
  });

  it("falls back to the device's zone for a zone name it does not know", () => {
    const instant = new Date(2026, 10, 8, 23, 30);
    expect(weekStart(instant, "Mars/Olympus_Mons")).toBe("2026-11-02");
  });

  it("refuses text that is neither a date nor a timestamp", () => {
    expect(() => weekStart("next tuesday")).toThrow(RangeError);
    expect(() => weekStart("")).toThrow(RangeError);
  });
});

describe("groupByWeek", () => {
  const orders = [
    { id: "a", at: "2026-11-03T18:00:00Z" }, // Tue, week of Nov 2
    { id: "b", at: "2026-11-10T18:00:00Z" }, // Tue, week of Nov 9
    { id: "c", at: "2026-11-05T18:00:00Z" }, // Thu, week of Nov 2
    { id: "d", at: "2026-11-09T04:00:00Z" }, // Sunday evening in LA: week of Nov 2
  ];

  it("groups by week, newest week first, and keeps input order inside a week", () => {
    const groups = groupByWeek(orders, (o) => o.at, LA);
    expect(groups.map((g) => g.weekStart)).toEqual(["2026-11-09", "2026-11-02"]);
    expect(groups[0]?.items.map((o) => o.id)).toEqual(["b"]);
    expect(groups[1]?.items.map((o) => o.id)).toEqual(["a", "c", "d"]);
  });

  it("cuts weeks in the zone it is given", () => {
    const utc = groupByWeek(orders, (o) => o.at, "UTC");
    expect(utc[0]?.items.map((o) => o.id)).toEqual(["b", "d"]);
  });

  it("takes plain calendar dates too, and returns nothing for nothing", () => {
    const days = groupByWeek([{ d: "2026-11-02" }, { d: "2026-11-08" }], (x) => x.d);
    expect(days).toHaveLength(1);
    expect(groupByWeek([], () => "2026-11-02")).toEqual([]);
  });
});

describe("recentWeeks", () => {
  it("lists Mondays, this week first", () => {
    expect(recentWeeks("2026-11-05", 3)).toEqual(["2026-11-02", "2026-10-26", "2026-10-19"]);
  });

  it("defaults to the history window and survives a year change", () => {
    const weeks = recentWeeks("2027-01-06");
    expect(weeks).toHaveLength(HISTORY_LIMITS.weeks);
    expect(weeks[0]).toBe("2027-01-04");
    expect(weeks[1]).toBe("2026-12-28");
  });

  it("asks for nothing and gets nothing", () => {
    expect(recentWeeks("2026-11-05", 0)).toEqual([]);
    expect(recentWeeks("2026-11-05", -2)).toEqual([]);
  });
});

describe("cookedStreak", () => {
  const today = "2026-11-05";

  it("counts consecutive days back from today", () => {
    expect(cookedStreak(["2026-11-05", "2026-11-04", "2026-11-03"], today)).toBe(3);
  });

  it("keeps the streak alive when today has nothing yet", () => {
    expect(cookedStreak(["2026-11-04", "2026-11-03"], today)).toBe(2);
  });

  it("ends at the first day with nothing cooked", () => {
    expect(cookedStreak(["2026-11-05", "2026-11-03", "2026-11-02"], today)).toBe(1);
  });

  it("is zero when yesterday and today are both empty", () => {
    expect(cookedStreak(["2026-11-03"], today)).toBe(0);
    expect(cookedStreak([], today)).toBe(0);
  });

  it("counts a day once however many meals were cooked, in any order, across a month end", () => {
    const dates = ["2026-11-01", "2026-10-31", "2026-11-01", "2026-10-30", "2026-10-29"];
    expect(cookedStreak(dates, "2026-11-01")).toBe(4);
    expect(cookedStreak(new Set(dates), "2026-11-02")).toBe(4);
  });
});

describe("parseMoneyInput", () => {
  it("reads the ways a person types a total", () => {
    expect(parseMoneyInput("123.45")).toBe(123.45);
    expect(parseMoneyInput("$123.45")).toBe(123.45);
    expect(parseMoneyInput(" $ 1,234.5 ")).toBe(1234.5);
    expect(parseMoneyInput("40")).toBe(40);
    expect(parseMoneyInput("40.")).toBe(40);
    expect(parseMoneyInput(".5")).toBe(0.5);
    expect(parseMoneyInput("0")).toBe(0);
  });

  it("refuses what is not an amount", () => {
    for (const text of ["", " ", "abc", "-5", "1.234", "1e3", "12.3.4", "$", "5 dollars", "NaN"]) {
      expect(parseMoneyInput(text), text).toBeNull();
    }
  });

  it("refuses more than the limit and accepts the limit", () => {
    expect(parseMoneyInput("100000")).toBe(100000);
    expect(parseMoneyInput("100000.01")).toBeNull();
  });
});

describe("orderWindowError", () => {
  it("accepts no window, a start alone, and a window within a day", () => {
    expect(orderWindowError(null, null)).toBeNull();
    expect(orderWindowError(undefined, undefined)).toBeNull();
    expect(orderWindowError("2026-11-04T16:00:00Z", null)).toBeNull();
    expect(orderWindowError("2026-11-04T16:00:00Z", "2026-11-04T17:00:00Z")).toBeNull();
    expect(orderWindowError("2026-11-04T16:00:00Z", "2026-11-05T16:00:00Z")).toBeNull();
  });

  it("names what is wrong", () => {
    expect(orderWindowError(null, "2026-11-04T17:00:00Z")).toBe("end_without_start");
    expect(orderWindowError("2026-11-04T17:00:00Z", "2026-11-04T16:00:00Z")).toBe(
      "end_not_after_start",
    );
    expect(orderWindowError("2026-11-04T16:00:00Z", "2026-11-04T16:00:00Z")).toBe(
      "end_not_after_start",
    );
    expect(orderWindowError("2026-11-04T16:00:00Z", "2026-11-05T16:00:01Z")).toBe("too_long");
  });

  it("reads Dates as well as timestamps", () => {
    expect(
      orderWindowError(new Date("2026-11-04T16:00:00Z"), new Date("2026-11-04T15:00:00Z")),
    ).toBe("end_not_after_start");
  });
});

describe("ConfirmOrderInput", () => {
  it("takes a total and nothing else", () => {
    expect(ConfirmOrderInput.parse({ total: 42.5 })).toEqual({ total: 42.5 });
  });

  it("takes the full set and trims text", () => {
    const parsed = ConfirmOrderInput.parse({
      total: 100,
      modality: "delivery",
      slotStart: "2026-11-04T16:00:00-08:00",
      slotEnd: "2026-11-04T17:00:00-08:00",
      retailerOrderId: "  KRG-1  ",
      notes: " side door ",
    });
    expect(parsed.retailerOrderId).toBe("KRG-1");
    expect(parsed.notes).toBe("side door");
  });

  it("refuses a bad total, modality or window", () => {
    expect(ConfirmOrderInput.safeParse({ total: -1 }).success).toBe(false);
    expect(ConfirmOrderInput.safeParse({ total: 100000.01 }).success).toBe(false);
    expect(ConfirmOrderInput.safeParse({ total: 5, modality: "curbside" }).success).toBe(false);
    expect(ConfirmOrderInput.safeParse({ total: 5, slotEnd: "2026-11-04T17:00:00Z" }).success).toBe(
      false,
    );
    const backwards = ConfirmOrderInput.safeParse({
      total: 5,
      slotStart: "2026-11-04T17:00:00Z",
      slotEnd: "2026-11-04T16:00:00Z",
    });
    expect(backwards.success).toBe(false);
    expect(
      ConfirmOrderInput.safeParse({ total: 5, notes: "x".repeat(HISTORY_LIMITS.notes + 1) })
        .success,
    ).toBe(false);
  });
});

describe("OrderPatch", () => {
  it("is every correctable column, all optional", () => {
    expect(OrderPatch.parse({})).toEqual({});
    expect(OrderPatch.parse({ status: "cancelled", notes: null })).toEqual({
      status: "cancelled",
      notes: null,
    });
    expect(OrderPatch.safeParse({ status: "refunded" }).success).toBe(false);
    expect(OrderPatch.safeParse({ run_id: UUID(1) }).success).toEqual(true); // unknown keys are dropped
    expect(OrderPatch.parse({ run_id: UUID(1) })).toEqual({});
  });
});

describe("order statuses", () => {
  it("are the four of docs/02 and only a cancelled order is not spend", () => {
    expect(OrderStatus.options).toEqual(["confirmed", "picked_up", "delivered", "cancelled"]);
    expect(OrderStatus.options.filter(countsAsSpend)).toEqual([
      "confirmed",
      "picked_up",
      "delivered",
    ]);
  });
});

describe("row schemas", () => {
  const order = {
    id: UUID(1),
    household_id: UUID(2),
    run_id: UUID(3),
    retailer: "kroger",
    retailer_order_id: null,
    modality: "pickup",
    slot_start: "2026-11-04T16:00:00+00:00",
    slot_end: null,
    total_usd: 123.45,
    status: "confirmed",
    confirmed_by: UUID(4),
    confirmed_at: "2026-11-02T18:00:00.123456+00:00",
    notes: null,
    created_at: "2026-11-02T18:00:00.123456+00:00",
    updated_at: "2026-11-02T18:00:00.123456+00:00",
  };

  it("reads an orders row as PostgREST returns it", () => {
    expect(Order.parse(order).total_usd).toBe(123.45);
  });

  it("reads a numeric that arrives as text", () => {
    expect(Order.parse({ ...order, total_usd: "123.45" }).total_usd).toBe(123.45);
    expect(Order.safeParse({ ...order, total_usd: "" }).success).toBe(false);
    expect(Order.safeParse({ ...order, total_usd: "abc" }).success).toBe(false);
  });

  it("reads an id that is not an RFC 4122 version, since it came from our own database", () => {
    const odd = "00000000-0000-0000-0000-000000000001";
    expect(Order.safeParse({ ...order, id: odd, run_id: odd }).success).toBe(true);
    expect(Order.safeParse({ ...order, id: "not-an-id" }).success).toBe(false);
  });

  it("refuses a retired retailer and an unknown status", () => {
    expect(Order.safeParse({ ...order, retailer: "instacart" }).success).toBe(false);
    expect(Order.safeParse({ ...order, status: "refunded" }).success).toBe(false);
  });

  it("reads a cooked week with its meals, one of them with no recipe title", () => {
    const week = MealsCookedWeek.parse({
      household_id: UUID(2),
      week_start: "2026-11-02",
      cooked_count: 2,
      entries: [
        { id: UUID(5), date: "2026-11-02", slot: "dinner", recipe_id: UUID(6), title: "Chili" },
        { id: UUID(7), date: "2026-11-03", slot: "lunch", recipe_id: UUID(8), title: null },
      ],
    });
    expect(week.entries).toHaveLength(2);
    expect(CookedMeal.safeParse({ ...week.entries[0], slot: "brunch" }).success).toBe(false);
  });

  it("reads a spend row", () => {
    const row = SpendWeekRow.parse({
      household_id: UUID(2),
      week_start: "2026-11-02",
      retailer: "kroger",
      store_name: null,
      total_usd: "65.50",
      order_count: 2,
    });
    expect(row.total_usd).toBe(65.5);
    expect(SpendWeekRow.safeParse({ ...row, order_count: 0 }).success).toBe(false);
  });

  it("reads a most-bought row and says which can be pinned", () => {
    const row = MostBoughtRow.parse({
      household_id: UUID(2),
      retailer: "kroger",
      store_id: "MOCK0001",
      store_name: "Mock QFC Duvall",
      ingredient_id: UUID(9),
      product_id: "P-ONION",
      upc: "0099010000004",
      product_name: "Harbor Fields Yellow Onions",
      size: "3 lb bag",
      times_bought: 2,
      units_bought: "3",
      last_bought_at: "2026-11-09T09:00:00+00:00",
      pinned: true,
    });
    expect(row.units_bought).toBe(3);
    expect(canPin(row)).toBe(true);
    expect(canPin({ ...row, ingredient_id: null })).toBe(false);
    expect(canPin({ ...row, store_id: null })).toBe(false);
  });
});

describe("the module is exported from the barrel", () => {
  it("exposes the WS12 names", async () => {
    const mod = await import("./index");
    for (const name of [
      "weekStart",
      "groupByWeek",
      "cookedStreak",
      "recentWeeks",
      "Order",
      "ConfirmOrderInput",
      "MostBoughtRow",
      "SpendWeekRow",
      "MealsCookedWeek",
      "parseMoneyInput",
      "HISTORY_LIMITS",
    ]) {
      expect(mod, name).toHaveProperty(name);
    }
  });
});
