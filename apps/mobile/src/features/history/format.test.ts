import { describe, expect, it } from "vitest";
import {
  clockLabel,
  dayLabel,
  formatUsd,
  MODALITY_LABEL,
  mealCountLabel,
  ORDER_STATUS_LABEL,
  orderCountLabel,
  RETAILER_NAME,
  storeLabel,
  timesBoughtLabel,
  totalFieldText,
  windowLabel,
} from "./format";

const local = (y: number, m: number, d: number, h = 0, min = 0) =>
  new Date(y, m - 1, d, h, min).toISOString();

describe("formatUsd", () => {
  it("writes dollars and cents with grouping", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(5)).toBe("$5.00");
    expect(formatUsd(65.5)).toBe("$65.50");
    expect(formatUsd(1234.5)).toBe("$1,234.50");
    expect(formatUsd(100000)).toBe("$100,000.00");
    expect(formatUsd(1234567.891)).toBe("$1,234,567.89");
  });

  it("keeps the sign of a negative amount", () => {
    expect(formatUsd(-12.3)).toBe("-$12.30");
  });
});

describe("totalFieldText", () => {
  it("is the amount as a field shows it, or nothing", () => {
    expect(totalFieldText(98)).toBe("98.00");
    expect(totalFieldText(0.5)).toBe("0.50");
    expect(totalFieldText(null)).toBe("");
    expect(totalFieldText(undefined)).toBe("");
  });
});

describe("storeLabel", () => {
  it("prefers the store's name and falls back to the retailer", () => {
    expect(storeLabel({ store_name: "QFC Duvall", retailer: "kroger" })).toBe("QFC Duvall");
    expect(storeLabel({ store_name: "  ", retailer: "kroger" })).toBe("Kroger");
    expect(storeLabel({ store_name: null, retailer: "costco" })).toBe("Costco");
    expect(storeLabel({ store_name: null, retailer: "newmart" })).toBe("newmart");
  });

  it("has a name for every retailer the app knows", () => {
    expect(Object.keys(RETAILER_NAME).sort()).toEqual(["costco", "kroger", "safeway"]);
  });
});

describe("labels", () => {
  it("name every order status and modality", () => {
    expect(ORDER_STATUS_LABEL).toEqual({
      confirmed: "Placed",
      picked_up: "Picked up",
      delivered: "Delivered",
      cancelled: "Cancelled",
    });
    expect(MODALITY_LABEL).toEqual({ pickup: "Pickup", delivery: "Delivery" });
  });

  it("count in words", () => {
    expect(orderCountLabel(1)).toBe("1 order");
    expect(orderCountLabel(3)).toBe("3 orders");
    expect(mealCountLabel(1)).toBe("1 meal");
    expect(mealCountLabel(0)).toBe("0 meals");
    expect(timesBoughtLabel(1)).toBe("Bought once");
    expect(timesBoughtLabel(4)).toBe("Bought 4 times");
  });

  it("use no em dashes", () => {
    const all = [
      ...Object.values(ORDER_STATUS_LABEL),
      ...Object.values(MODALITY_LABEL),
      orderCountLabel(2),
      timesBoughtLabel(2),
    ];
    for (const text of all) expect(text).not.toContain("—");
  });
});

describe("clockLabel", () => {
  it("writes a 12-hour clock in lower case", () => {
    expect(clockLabel(new Date(2026, 10, 4, 16, 0))).toBe("4:00 pm");
    expect(clockLabel(new Date(2026, 10, 4, 9, 5))).toBe("9:05 am");
    expect(clockLabel(new Date(2026, 10, 4, 0, 30))).toBe("12:30 am");
    expect(clockLabel(new Date(2026, 10, 4, 12, 0))).toBe("12:00 pm");
  });
});

describe("dayLabel and windowLabel", () => {
  it("names the day on the device", () => {
    expect(dayLabel(local(2026, 11, 4, 16))).toBe("Wed, Nov 4");
    expect(dayLabel(new Date(2026, 10, 2, 23, 30))).toBe("Mon, Nov 2");
  });

  it("writes a window within a day", () => {
    expect(windowLabel(local(2026, 11, 4, 16), local(2026, 11, 4, 17, 30))).toBe(
      "Wed, Nov 4, 4:00 pm to 5:30 pm",
    );
  });

  it("writes a window that has only a start", () => {
    expect(windowLabel(local(2026, 11, 4, 16), null)).toBe("Wed, Nov 4, from 4:00 pm");
  });

  it("writes a window that crosses midnight with both days", () => {
    expect(windowLabel(local(2026, 11, 4, 22), local(2026, 11, 5, 1))).toBe(
      "Wed, Nov 4, 10:00 pm to Thu, Nov 5, 1:00 am",
    );
  });

  it("is empty with no start", () => {
    expect(windowLabel(null, null)).toBe("");
    expect(windowLabel(null, local(2026, 11, 4, 17))).toBe("");
  });
});
