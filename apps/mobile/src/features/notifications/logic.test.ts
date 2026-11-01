import { NOTIFICATION_TYPES } from "@mp/core";
import { describe, expect, it } from "vitest";
import { NOTIFICATION_ROWS, quietDraftOf, sameQuiet, toQuietHours } from "./logic";

describe("the notification rows", () => {
  it("has one row for each type, in a stable order", () => {
    expect(NOTIFICATION_ROWS.map((r) => r.type).sort()).toEqual([...NOTIFICATION_TYPES].sort());
  });

  it("uses plain words with no em dashes", () => {
    for (const row of NOTIFICATION_ROWS) {
      expect(`${row.label} ${row.help}`).not.toMatch(/—|–/);
      expect(row.label.length).toBeGreaterThan(3);
    }
  });
});

describe("quiet hours", () => {
  it("shows off with the overnight default when there are none", () => {
    expect(quietDraftOf(null)).toEqual({
      enabled: false,
      startHour: 21,
      startMinute: 0,
      endHour: 7,
      endMinute: 0,
    });
  });

  it("round trips what is stored", () => {
    const draft = quietDraftOf({ start: "22:30", end: "06:15" });
    expect(draft).toEqual({
      enabled: true,
      startHour: 22,
      startMinute: 30,
      endHour: 6,
      endMinute: 15,
    });
    expect(toQuietHours(draft)).toEqual({ ok: true, quietHours: { start: "22:30", end: "06:15" } });
  });

  it("saves nothing when switched off, and refuses a start equal to the end", () => {
    expect(toQuietHours({ ...quietDraftOf(null), enabled: false })).toEqual({
      ok: true,
      quietHours: null,
    });
    expect(
      toQuietHours({ enabled: true, startHour: 7, startMinute: 0, endHour: 7, endMinute: 0 }),
    ).toMatchObject({ ok: false });
  });

  it("knows an edit that changes nothing", () => {
    const stored = quietDraftOf({ start: "21:00", end: "07:00" });
    expect(sameQuiet(stored, { ...stored })).toBe(true);
    expect(sameQuiet(stored, { ...stored, endHour: 8 })).toBe(false);
    expect(sameQuiet(quietDraftOf(null), { ...quietDraftOf(null), startHour: 1 })).toBe(true);
    expect(sameQuiet(quietDraftOf(null), stored)).toBe(false);
  });
});
