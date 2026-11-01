import { describe, expect, it } from "vitest";
import { buildWindow, clockText, parseClock, pickupDays } from "./pickupWindow";

const local = (y: number, m: number, d: number, h: number, min = 0) =>
  new Date(y, m - 1, d, h, min).toISOString();

describe("pickupDays", () => {
  it("is today and the next six days, named", () => {
    const days = pickupDays("2026-11-04");
    expect(days).toHaveLength(7);
    expect(days[0]).toEqual({ iso: "2026-11-04", label: "Today" });
    expect(days[1]).toEqual({ iso: "2026-11-05", label: "Tomorrow" });
    expect(days[2]).toEqual({ iso: "2026-11-06", label: "Fri Nov 6" });
    expect(days[6]).toEqual({ iso: "2026-11-10", label: "Tue Nov 10" });
  });

  it("crosses a month and a year end", () => {
    expect(pickupDays("2026-12-30").map((d) => d.iso)).toEqual([
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
      "2027-01-03",
      "2027-01-04",
      "2027-01-05",
    ]);
  });
});

describe("parseClock", () => {
  it("reads the ways a person types a time", () => {
    expect(parseClock("4pm")).toEqual({ hour: 16, minute: 0 });
    expect(parseClock("4 PM")).toEqual({ hour: 16, minute: 0 });
    expect(parseClock("4:30 pm")).toEqual({ hour: 16, minute: 30 });
    expect(parseClock("4:30pm")).toEqual({ hour: 16, minute: 30 });
    expect(parseClock("9 a.m.")).toEqual({ hour: 9, minute: 0 });
    expect(parseClock("11:59 am")).toEqual({ hour: 11, minute: 59 });
    expect(parseClock("  7:05 am ")).toEqual({ hour: 7, minute: 5 });
    expect(parseClock("16:00")).toEqual({ hour: 16, minute: 0 });
    expect(parseClock("07:30")).toEqual({ hour: 7, minute: 30 });
    expect(parseClock("0:15")).toEqual({ hour: 0, minute: 15 });
  });

  it("puts noon and midnight where they belong", () => {
    expect(parseClock("12pm")).toEqual({ hour: 12, minute: 0 });
    expect(parseClock("12:30 pm")).toEqual({ hour: 12, minute: 30 });
    expect(parseClock("12am")).toEqual({ hour: 0, minute: 0 });
    expect(parseClock("12:15 am")).toEqual({ hour: 0, minute: 15 });
  });

  it("refuses a bare number, which could be either end of the day, and anything else", () => {
    for (const text of [
      "4",
      "",
      " ",
      "noon",
      "13pm",
      "0pm",
      "4:60 pm",
      "25:00",
      "24:00",
      "4:5 pm",
      "4pm5",
      "pm",
    ]) {
      expect(parseClock(text), text).toBeNull();
    }
  });
});

describe("buildWindow", () => {
  const day = "2026-11-04";

  it("is no window when both times are blank", () => {
    expect(buildWindow({ day, start: "", end: "" })).toEqual({
      ok: true,
      slotStart: null,
      slotEnd: null,
    });
    expect(buildWindow({ day, start: "  ", end: " " })).toEqual({
      ok: true,
      slotStart: null,
      slotEnd: null,
    });
  });

  it("builds a window in the device's zone", () => {
    expect(buildWindow({ day, start: "4pm", end: "5:30 pm" })).toEqual({
      ok: true,
      slotStart: local(2026, 11, 4, 16),
      slotEnd: local(2026, 11, 4, 17, 30),
    });
  });

  it("builds a window with only a start", () => {
    expect(buildWindow({ day, start: "9:00 am", end: "" })).toEqual({
      ok: true,
      slotStart: local(2026, 11, 4, 9),
      slotEnd: null,
    });
  });

  it("asks for a start when only an end was typed", () => {
    const result = buildWindow({ day, start: "", end: "5pm" });
    expect(result).toMatchObject({ ok: false, field: "start" });
  });

  it("names the field that cannot be read", () => {
    expect(buildWindow({ day, start: "soon", end: "" })).toMatchObject({
      ok: false,
      field: "start",
    });
    expect(buildWindow({ day, start: "4pm", end: "later" })).toMatchObject({
      ok: false,
      field: "end",
    });
  });

  it("refuses an end that is not after the start", () => {
    expect(buildWindow({ day, start: "5pm", end: "4pm" })).toMatchObject({
      ok: false,
      field: "end",
    });
    expect(buildWindow({ day, start: "5pm", end: "5:00 pm" })).toMatchObject({
      ok: false,
      field: "end",
    });
  });

  it("refuses a day that is not a date", () => {
    expect(buildWindow({ day: "tomorrow", start: "4pm", end: "" })).toMatchObject({ ok: false });
  });

  it("stays right across the nights the clocks change", () => {
    // Local times, whichever zone the test runs in: the hour typed is the hour stored.
    for (const date of ["2026-03-08", "2026-11-01"]) {
      const result = buildWindow({ day: date, start: "10:00 am", end: "11:00 am" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(new Date(result.slotStart ?? "").getHours()).toBe(10);
        expect(new Date(result.slotEnd ?? "").getHours()).toBe(11);
      }
    }
  });
});

describe("clockText", () => {
  it("prefills an edit from a stored timestamp", () => {
    expect(clockText(local(2026, 11, 4, 16, 0))).toBe("4:00 pm");
    expect(clockText(local(2026, 11, 4, 9, 5))).toBe("9:05 am");
  });
});
