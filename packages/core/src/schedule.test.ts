import { describe, expect, it } from "vitest";
import {
  cadenceToCron,
  cronToCadence,
  DEFAULT_SCHEDULE_CADENCE,
  isQuietAt,
  isValidCron,
  isValidTimeZone,
  localDateOf,
  localParts,
  NotificationPayload,
  nextRunAt,
  notificationTypeOf,
  parseCron,
  payloadTypeOf,
  QuietHours,
  quietHoursEnd,
  resolveTargetWeekStart,
  ScheduleError,
  ScheduleInput,
  SchedulePolicy,
  upcomingRuns,
} from "./schedule.ts";

const LA = "America/Los_Angeles";
const iso = (d: Date) => d.toISOString();

describe("parseCron", () => {
  it("reads a weekly cron", () => {
    expect(parseCron("0 9 * * 6")).toEqual({ minute: 0, hour: 9, weekdays: [6] });
    expect(parseCron("  30 18 * * 5  ")).toEqual({ minute: 30, hour: 18, weekdays: [5] });
  });

  it("reads lists, ranges, every day, and Sunday as 0 or 7", () => {
    expect(parseCron("0 7 * * *").weekdays).toBeNull();
    expect(parseCron("0 7 * * 1-5").weekdays).toEqual([1, 2, 3, 4, 5]);
    expect(parseCron("0 7 * * 0,6").weekdays).toEqual([6, 7]);
    expect(parseCron("0 7 * * 7,6,6").weekdays).toEqual([6, 7]);
    expect(parseCron("0 7 * * 5-7").weekdays).toEqual([5, 6, 7]);
  });

  it("refuses what the scheduler does not run", () => {
    for (const cron of [
      "",
      "0 9 * * SAT",
      "*/5 * * * *",
      "0 9 1 * 6",
      "0 9 * 11 6",
      "60 9 * * 6",
      "0 24 * * 6",
      "0 9 * * 8",
      "0 9 * * 6-5",
      "0 9 * * 1/2",
      "0 9 * *",
      "0,30 9 * * 6",
      "0 9,10 * * 6",
    ]) {
      expect(isValidCron(cron), cron).toBe(false);
      expect(() => parseCron(cron), cron).toThrow(ScheduleError);
    }
  });
});

describe("nextRunAt", () => {
  it("finds the coming Saturday 9:00 for a weekly schedule", () => {
    // Wednesday 2026-10-28 12:00 UTC. Saturday 2026-10-31 09:00 PDT is 16:00 UTC.
    expect(iso(nextRunAt("0 9 * * 6", LA, new Date("2026-10-28T12:00:00Z")))).toBe(
      "2026-10-31T16:00:00.000Z",
    );
  });

  it("moves to the next week when `from` is exactly the scheduled time", () => {
    const at = new Date("2026-10-31T16:00:00.000Z");
    expect(iso(nextRunAt("0 9 * * 6", LA, at))).toBe("2026-11-07T17:00:00.000Z");
  });

  it("stays on the same time when `from` is a millisecond before it", () => {
    const before = new Date("2026-10-31T15:59:59.999Z");
    expect(iso(nextRunAt("0 9 * * 6", LA, before))).toBe("2026-10-31T16:00:00.000Z");
  });

  it("keeps 9:00 on the wall clock across the November change back (PDT to PST)", () => {
    // 2026-11-01 02:00 PDT becomes 01:00 PST. Saturday 10-31 is 16:00Z, Saturday 11-07 is 17:00Z.
    const runs = upcomingRuns("0 9 * * 6", LA, new Date("2026-10-24T20:00:00Z"), 3);
    expect(runs.map(iso)).toEqual([
      "2026-10-31T16:00:00.000Z",
      "2026-11-07T17:00:00.000Z",
      "2026-11-14T17:00:00.000Z",
    ]);
    for (const run of runs) expect(localParts(run, LA)).toMatchObject({ hour: 9, minute: 0 });
  });

  it("keeps 9:00 on the wall clock across the March change forward (PST to PDT)", () => {
    // 2026-03-08 02:00 PST becomes 03:00 PDT. Saturday 03-07 is 17:00Z, Saturday 03-14 is 16:00Z.
    const runs = upcomingRuns("0 9 * * 6", LA, new Date("2026-02-28T20:00:00Z"), 3);
    expect(runs.map(iso)).toEqual([
      "2026-03-07T17:00:00.000Z",
      "2026-03-14T16:00:00.000Z",
      "2026-03-21T16:00:00.000Z",
    ]);
    for (const run of runs) expect(localParts(run, LA)).toMatchObject({ hour: 9, minute: 0 });
  });

  it("runs a job that sits in the skipped hour once, an hour later (March)", () => {
    // 02:30 on 2026-03-08 does not exist in Los Angeles. Postgres reads it with the PST offset,
    // which is 10:30Z, 03:30 PDT. The nights either side run at 02:30 on the clock.
    const runs = upcomingRuns("30 2 * * *", LA, new Date("2026-03-07T12:00:00Z"), 3);
    expect(runs.map(iso)).toEqual([
      "2026-03-08T10:30:00.000Z",
      "2026-03-09T09:30:00.000Z",
      "2026-03-10T09:30:00.000Z",
    ]);
    expect(iso(nextRunAt("30 2 * * *", LA, new Date("2026-03-06T12:00:00Z")))).toBe(
      "2026-03-07T10:30:00.000Z",
    );
  });

  it("runs a job that sits in the repeated hour once, at the later time (November)", () => {
    // 01:30 on 2026-11-01 happens twice. Postgres picks the second, 01:30 PST, which is 09:30Z.
    const runs = upcomingRuns("30 1 * * *", LA, new Date("2026-10-31T09:00:00Z"), 3);
    expect(runs.map(iso)).toEqual([
      "2026-11-01T09:30:00.000Z",
      "2026-11-02T09:30:00.000Z",
      "2026-11-03T09:30:00.000Z",
    ]);
  });

  it("reads `from` on the schedule's own wall clock, not UTC's", () => {
    // 2026-11-01T03:00Z is still Saturday 10-31 20:00 PDT, so Saturday 9:00 has passed.
    expect(iso(nextRunAt("0 9 * * 6", LA, new Date("2026-11-01T03:00:00Z")))).toBe(
      "2026-11-07T17:00:00.000Z",
    );
    // 2026-10-31T05:00Z is Friday 22:00 PDT: Saturday 9:00 is the next morning.
    expect(iso(nextRunAt("0 9 * * 6", LA, new Date("2026-10-31T05:00:00Z")))).toBe(
      "2026-10-31T16:00:00.000Z",
    );
  });

  it("handles zones ahead of UTC, with half hour offsets and no daylight saving", () => {
    // Asia/Kolkata is UTC+5:30 all year: Saturday 9:00 there is 03:30Z.
    expect(iso(nextRunAt("0 9 * * 6", "Asia/Kolkata", new Date("2026-10-28T00:00:00Z")))).toBe(
      "2026-10-31T03:30:00.000Z",
    );
    // Pacific/Auckland is NZDT (UTC+13) in November.
    expect(iso(nextRunAt("0 9 * * 6", "Pacific/Auckland", new Date("2026-11-04T00:00:00Z")))).toBe(
      "2026-11-06T20:00:00.000Z",
    );
    expect(iso(nextRunAt("0 9 * * 6", "UTC", new Date("2026-10-28T00:00:00Z")))).toBe(
      "2026-10-31T09:00:00.000Z",
    );
  });

  it("supports weekday lists and every day", () => {
    const from = new Date("2026-10-30T20:00:00Z"); // Friday 13:00 PDT
    expect(iso(nextRunAt("0 18 * * 1-5", LA, from))).toBe("2026-10-31T01:00:00.000Z"); // Fri 18:00
    expect(iso(nextRunAt("0 18 * * 1-5", LA, new Date("2026-10-31T01:00:00Z")))).toBe(
      "2026-11-03T02:00:00.000Z", // Mon 18:00 is after the change back: PST
    );
    expect(iso(nextRunAt("15 6 * * *", LA, from))).toBe("2026-10-31T13:15:00.000Z");
  });

  it("rejects bad input with a ScheduleError", () => {
    expect(() => nextRunAt("nope", LA, new Date())).toThrow(ScheduleError);
    expect(() => nextRunAt("0 9 * * 6", "Mars/Olympus", new Date())).toThrow(ScheduleError);
    expect(() => nextRunAt("0 9 * * 6", LA, new Date(Number.NaN))).toThrow(ScheduleError);
  });
});

describe("zones", () => {
  it("knows a zone from a typo", () => {
    expect(isValidTimeZone("America/Los_Angeles")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("America/Los_Angelez")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone(" UTC")).toBe(false);
  });

  it("reads a date on a wall clock", () => {
    const at = new Date("2026-11-03T03:00:00Z");
    expect(localDateOf(at, LA)).toBe("2026-11-02");
    expect(localDateOf(at, "UTC")).toBe("2026-11-03");
    expect(localParts(at, LA)).toMatchObject({ hour: 19, isoWeekday: 1 });
  });
});

describe("resolveTargetWeekStart", () => {
  it("is the Monday after a Saturday run", () => {
    // Saturday 2026-10-31 09:00 PDT.
    expect(resolveTargetWeekStart(new Date("2026-10-31T16:00:00Z"), LA)).toBe("2026-11-02");
  });

  it("is the Monday after a Sunday and the same Monday on a Monday", () => {
    expect(resolveTargetWeekStart(new Date("2026-11-01T20:00:00Z"), LA)).toBe("2026-11-02");
    expect(resolveTargetWeekStart(new Date("2026-11-02T17:00:00Z"), LA)).toBe("2026-11-02");
  });

  it("is the Monday a week later from Tuesday through Friday", () => {
    expect(resolveTargetWeekStart(new Date("2026-11-03T18:00:00Z"), LA)).toBe("2026-11-09");
    expect(resolveTargetWeekStart(new Date("2026-11-06T18:00:00Z"), LA)).toBe("2026-11-09");
  });

  it("reads the day in the schedule's zone, not UTC", () => {
    // 2026-11-03T03:00Z is Monday 19:00 in Los Angeles but Tuesday in UTC.
    const at = new Date("2026-11-03T03:00:00Z");
    expect(resolveTargetWeekStart(at, LA)).toBe("2026-11-02");
    expect(resolveTargetWeekStart(at, "UTC")).toBe("2026-11-09");
  });
});

describe("cadence", () => {
  it("round trips the editor's weekday and time", () => {
    expect(cadenceToCron(DEFAULT_SCHEDULE_CADENCE)).toBe("0 9 * * 6");
    expect(cronToCadence("0 9 * * 6")).toEqual({ weekday: 6, hour: 9, minute: 0 });
    expect(cronToCadence("45 17 * * 0")).toEqual({ weekday: 7, hour: 17, minute: 45 });
    expect(cadenceToCron({ weekday: 7, hour: 0, minute: 5 })).toBe("5 0 * * 7");
  });

  it("returns null for a cron the editor cannot show", () => {
    expect(cronToCadence("0 9 * * 1-5")).toBeNull();
    expect(cronToCadence("0 9 * * *")).toBeNull();
    expect(cronToCadence("garbage")).toBeNull();
  });

  it("refuses an hour or minute off the clock", () => {
    expect(() => cadenceToCron({ weekday: 6, hour: 24, minute: 0 })).toThrow(ScheduleError);
    expect(() => cadenceToCron({ weekday: 6, hour: 9, minute: 60 })).toThrow(ScheduleError);
  });
});

describe("quiet hours", () => {
  const quiet = { start: "21:00", end: "07:00" };

  it("holds across midnight", () => {
    // Los Angeles is PDT (UTC-7) on 2026-10-30.
    expect(isQuietAt(new Date("2026-10-31T04:00:00Z"), quiet, LA)).toBe(true); // 21:00 Fri
    expect(isQuietAt(new Date("2026-10-31T08:00:00Z"), quiet, LA)).toBe(true); // 01:00 Sat
    expect(isQuietAt(new Date("2026-10-31T13:59:00Z"), quiet, LA)).toBe(true); // 06:59 Sat
    expect(isQuietAt(new Date("2026-10-31T14:00:00Z"), quiet, LA)).toBe(false); // 07:00 Sat
    expect(isQuietAt(new Date("2026-10-31T03:59:00Z"), quiet, LA)).toBe(false); // 20:59 Fri
  });

  it("holds inside one day", () => {
    const nap = { start: "13:00", end: "15:00" };
    expect(isQuietAt(new Date("2026-10-31T19:59:00Z"), nap, LA)).toBe(false); // 12:59 PDT
    expect(isQuietAt(new Date("2026-10-31T20:00:00Z"), nap, LA)).toBe(true); // 13:00 PDT
    expect(isQuietAt(new Date("2026-10-31T21:00:00Z"), nap, LA)).toBe(true); // 14:00 PDT
    expect(isQuietAt(new Date("2026-10-31T22:00:00Z"), nap, LA)).toBe(false); // 15:00 PDT
  });

  it("is never quiet with no quiet hours set", () => {
    expect(isQuietAt(new Date("2026-10-31T08:00:00Z"), null, LA)).toBe(false);
    expect(quietHoursEnd(new Date("2026-10-31T08:00:00Z"), null, LA)).toBeNull();
  });

  it("ends at the household's own 07:00, in its zone", () => {
    expect(iso(quietHoursEnd(new Date("2026-10-31T08:00:00Z"), quiet, LA) as Date)).toBe(
      "2026-10-31T14:00:00.000Z",
    );
    // Before midnight the end is the next morning.
    expect(iso(quietHoursEnd(new Date("2026-10-31T05:00:00Z"), quiet, LA) as Date)).toBe(
      "2026-10-31T14:00:00.000Z",
    );
    // After the change back the same 07:00 is an hour later in UTC.
    expect(iso(quietHoursEnd(new Date("2026-11-02T08:00:00Z"), quiet, LA) as Date)).toBe(
      "2026-11-02T15:00:00.000Z",
    );
  });

  it("has no end outside quiet hours", () => {
    expect(quietHoursEnd(new Date("2026-10-31T20:00:00Z"), quiet, LA)).toBeNull();
  });

  it("validates its shape", () => {
    expect(QuietHours.safeParse(quiet).success).toBe(true);
    expect(QuietHours.safeParse({ start: "21:00", end: "21:00" }).success).toBe(false);
    expect(QuietHours.safeParse({ start: "9pm", end: "07:00" }).success).toBe(false);
    expect(QuietHours.safeParse({ start: "24:00", end: "07:00" }).success).toBe(false);
    expect(QuietHours.safeParse({ ...quiet, tz: LA }).success).toBe(false);
  });
});

describe("notifications", () => {
  const id = "0a000000-0000-4000-8000-00000000000a";

  it("maps needs_review to the stored items_need_review and back", () => {
    expect(notificationTypeOf({ type: "needs_review" })).toBe("items_need_review");
    expect(notificationTypeOf({ type: "cart_ready" })).toBe("cart_ready");
    expect(payloadTypeOf("items_need_review")).toBe("needs_review");
    expect(payloadTypeOf("weekly_nudge")).toBe("weekly_nudge");
  });

  it("parses each payload and refuses an unknown one", () => {
    expect(
      NotificationPayload.safeParse({
        type: "cart_ready",
        runId: id,
        storeName: "QFC",
        subtotalUsd: 9,
      }).success,
    ).toBe(true);
    expect(
      NotificationPayload.safeParse({
        type: "schedule_skipped",
        scheduleId: id,
        reason: "no_active_list",
        weekStart: "2026-11-02",
      }).success,
    ).toBe(true);
    expect(
      NotificationPayload.safeParse({ type: "weekly_nudge", weekStart: "2026-11-02" }).success,
    ).toBe(true);
    expect(NotificationPayload.safeParse({ type: "marketing" }).success).toBe(false);
    expect(
      NotificationPayload.safeParse({
        type: "schedule_skipped",
        scheduleId: id,
        reason: "other",
        weekStart: null,
      }).success,
    ).toBe(false);
  });
});

describe("schedule input", () => {
  const connection = "7a000000-0000-4000-8000-0000000000a1";

  it("accepts a weekly schedule with the editor's policy keys", () => {
    expect(
      ScheduleInput.safeParse({
        cron: "0 9 * * 6",
        tz: LA,
        connection_id: connection,
        policy: { budget_cap_usd: 150, substitution: "same_brand" },
        enabled: true,
      }).success,
    ).toBe(true);
  });

  it("refuses auto_checkout, a bad cron and a bad zone", () => {
    expect(SchedulePolicy.safeParse({ auto_checkout: true }).success).toBe(false);
    expect(SchedulePolicy.safeParse({ budget_cap_usd: 0 }).success).toBe(false);
    const base = {
      cron: "0 9 * * 6",
      tz: LA,
      connection_id: connection,
      policy: {},
      enabled: true,
    };
    expect(ScheduleInput.safeParse({ ...base, cron: "every saturday" }).success).toBe(false);
    expect(ScheduleInput.safeParse({ ...base, tz: "Nowhere/Land" }).success).toBe(false);
  });
});
