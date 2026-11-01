// Schedules, quiet hours and notification payloads (WS11). Pure: no I/O, no cron library. Time
// zones come from Intl, which Node, Hermes and browsers all ship.
//
// The cron subset. A schedule's `cron` is a five-field cron in the schedule's own time zone, cut
// down to what a household can mean by "shop for me on Saturday at 9": a single minute, a single
// hour, `*` for day of month and month, and a weekday field of `*`, numbers, ranges and comma
// lists (0 or 7 is Sunday). `public.scheduled_run_next` in the WS11 migration implements the same
// subset in SQL, and a test runs both on the same inputs, so the editor's preview and the
// scheduler agree.
//
// Wall clock times follow Postgres: a time that does not exist (the hour skipped when clocks go
// forward) happens at the same instant as the time an hour later, and a time that happens twice
// (when clocks go back) is the second one, so a daily 02:30 job runs once on both nights.
import { z } from "zod";
import { addDays, mondayIndex } from "./planning.ts";
import { RunSubstitution } from "./run.ts";

/** Used when a household has set no time zone (the app launches in Washington State). */
export const DEFAULT_TIME_ZONE = "America/Los_Angeles";

// ---------------------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let found = formatters.get(tz);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, found);
  }
  return found;
}

/** True for a zone name the runtime knows ("America/Los_Angeles", "UTC"). */
export function isValidTimeZone(tz: string): boolean {
  if (typeof tz !== "string" || tz.trim() === "" || tz !== tz.trim()) return false;
  try {
    formatterFor(tz);
    return true;
  } catch {
    return false;
  }
}

export class ScheduleError extends Error {
  readonly code: "invalid_cron" | "invalid_time_zone" | "invalid_date" | "invalid_quiet_hours";
  constructor(code: ScheduleError["code"], message: string) {
    super(message);
    this.name = "ScheduleError";
    this.code = code;
  }
}

function assertZone(tz: string): void {
  if (!isValidTimeZone(tz)) {
    throw new ScheduleError("invalid_time_zone", `Not a time zone: ${String(tz).slice(0, 60)}`);
  }
}

/** The calendar and clock fields of an instant on a wall clock. */
export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 1 for Monday through 7 for Sunday. */
  isoWeekday: number;
}

function partsAt(ms: number, tz: string): LocalParts {
  const out: Record<string, number> = {};
  for (const part of formatterFor(tz).formatToParts(new Date(ms))) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  const year = out.year ?? 0;
  const month = out.month ?? 1;
  const day = out.day ?? 1;
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0 = Sunday
  return {
    year,
    month,
    day,
    hour: (out.hour ?? 0) % 24,
    minute: out.minute ?? 0,
    second: out.second ?? 0,
    isoWeekday: weekday === 0 ? 7 : weekday,
  };
}

/** The wall clock reading of `date` in `tz`. */
export function localParts(date: Date, tz: string): LocalParts {
  assertZone(tz);
  const ms = date.getTime();
  if (!Number.isFinite(ms)) throw new ScheduleError("invalid_date", "Not a valid date");
  return partsAt(ms, tz);
}

/** The calendar date (YYYY-MM-DD) of `date` in `tz`. */
export function localDateOf(date: Date, tz: string): string {
  const p = localParts(date, tz);
  return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Milliseconds `tz` is ahead of UTC at `ms`. */
function offsetAt(ms: number, tz: string): number {
  const p = partsAt(ms, tz);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wallAsUtc - Math.floor(ms / 1000) * 1000;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The instant at which the wall clock of `tz` reads the given date and time. A time the clock skips
 * is read with the offset from before the change; a time it shows twice is the later one.
 */
function wallToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const before = offsetAt(naive - MS_PER_DAY, tz);
  const after = offsetAt(naive + MS_PER_DAY, tz);
  const first = naive - before;
  const second = naive - after;
  const firstValid = offsetAt(first, tz) === before;
  const secondValid = offsetAt(second, tz) === after;
  if (firstValid && secondValid) return Math.max(first, second);
  if (firstValid) return first;
  if (secondValid) return second;
  return first;
}

// ---------------------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------------------

/** 1 for Monday through 7 for Sunday, the way Postgres `isodow` counts. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const WEEKDAY_NAMES: Readonly<Record<IsoWeekday, string>> = {
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
  7: "Sunday",
};

export interface ParsedCron {
  minute: number;
  hour: number;
  /** Sorted ISO weekdays, or null for every day. */
  weekdays: IsoWeekday[] | null;
}

const CRON_PATTERN =
  /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+(\*|[0-7](?:-[0-7])?(?:,[0-7](?:-[0-7])?)*)$/;

function cronError(cron: string, why: string): ScheduleError {
  return new ScheduleError("invalid_cron", `${why}: "${String(cron).slice(0, 60)}"`);
}

/** Reads the supported cron subset, or throws a ScheduleError saying what is not supported. */
export function parseCron(cron: string): ParsedCron {
  if (typeof cron !== "string") throw cronError(String(cron), "A cron is text");
  const match = CRON_PATTERN.exec(cron.trim());
  if (!match) {
    throw cronError(
      cron,
      "Only 'minute hour * * weekdays' is supported, for example '0 9 * * 6' for Saturday at 9:00",
    );
  }
  const minute = Number(match[1]);
  const hour = Number(match[2]);
  if (minute > 59) throw cronError(cron, "The minute is 0 to 59");
  if (hour > 23) throw cronError(cron, "The hour is 0 to 23");
  const field = match[3] ?? "*";
  if (field === "*") return { minute, hour, weekdays: null };
  const days = new Set<IsoWeekday>();
  for (const item of field.split(",")) {
    const [from, to] = item.split("-").map(Number) as [number, number | undefined];
    const last = to ?? from;
    if (last < from) throw cronError(cron, "A weekday range runs upward");
    for (let day = from; day <= last; day++) days.add((day === 0 ? 7 : day) as IsoWeekday);
  }
  return { minute, hour, weekdays: [...days].sort((a, b) => a - b) };
}

export function isValidCron(cron: string): boolean {
  try {
    parseCron(cron);
    return true;
  } catch {
    return false;
  }
}

/**
 * The first moment strictly after `from` at which `cron` fires on the wall clock of `tz`. A `from`
 * exactly on a firing time gets the next one.
 */
export function nextRunAt(cron: string, tz: string, from: Date): Date {
  const spec = parseCron(cron);
  assertZone(tz);
  const fromMs = from.getTime();
  if (!Number.isFinite(fromMs)) throw new ScheduleError("invalid_date", "Not a valid date");
  const start = partsAt(fromMs, tz);
  const startDay = Date.UTC(start.year, start.month - 1, start.day);
  for (let offset = 0; offset <= 8; offset++) {
    const day = new Date(startDay + offset * MS_PER_DAY);
    const weekday = day.getUTCDay() === 0 ? 7 : day.getUTCDay();
    if (spec.weekdays && !spec.weekdays.includes(weekday as IsoWeekday)) continue;
    const at = wallToInstant(
      day.getUTCFullYear(),
      day.getUTCMonth() + 1,
      day.getUTCDate(),
      spec.hour,
      spec.minute,
      tz,
    );
    if (at > fromMs) return new Date(at);
  }
  throw cronError(cron, "No firing time found");
}

/** The next `count` firing times after `from`. */
export function upcomingRuns(cron: string, tz: string, from: Date, count: number): Date[] {
  const out: Date[] = [];
  let cursor = from;
  for (let i = 0; i < count; i++) {
    cursor = nextRunAt(cron, tz, cursor);
    out.push(cursor);
  }
  return out;
}

/** One weekday at one time: what the schedule editor edits. */
export interface Cadence {
  weekday: IsoWeekday;
  hour: number;
  minute: number;
}

/** `{ weekday: 6, hour: 9, minute: 0 }` becomes `0 9 * * 6`. */
export function cadenceToCron(cadence: Cadence): string {
  const { weekday, hour, minute } = cadence;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw cronError("", "The hour is 0 to 23");
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw cronError("", "The minute is 0 to 59");
  }
  if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
    throw cronError("", "The weekday is 1 (Monday) to 7 (Sunday)");
  }
  return `${minute} ${hour} * * ${weekday}`;
}

/** The editor's view of a cron, or null when it is not a single weekday at a single time. */
export function cronToCadence(cron: string): Cadence | null {
  let spec: ParsedCron;
  try {
    spec = parseCron(cron);
  } catch {
    return null;
  }
  const only = spec.weekdays?.length === 1 ? spec.weekdays[0] : undefined;
  return only === undefined ? null : { weekday: only, hour: spec.hour, minute: spec.minute };
}

/** "09:00" for 9, 0. */
export function formatClock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** The household's first suggested schedule: Saturday 9:00 for the week starting Monday. */
export const DEFAULT_SCHEDULE_CADENCE: Cadence = { weekday: 6, hour: 9, minute: 0 };

// ---------------------------------------------------------------------------------------
// Which week a run shops for
// ---------------------------------------------------------------------------------------

/**
 * The Monday (YYYY-MM-DD, `meal_plans.week_start`) of the week a run at `runAt` shops for: the
 * first Monday on or after that day on the wall clock of `tz`. A Saturday 9:00 run shops for the
 * Monday two days later; a run on the Monday itself shops for that Monday.
 */
export function resolveTargetWeekStart(runAt: Date, tz: string): string {
  const day = localDateOf(runAt, tz);
  const index = mondayIndex(day);
  return index === 0 ? day : addDays(day, 7 - index);
}

// ---------------------------------------------------------------------------------------
// Quiet hours
// ---------------------------------------------------------------------------------------

const CLOCK_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Postgres `households.quiet_hours`: the household's zone is `households.timezone`. */
export const QuietHours = z
  .object({
    start: z.string().regex(CLOCK_PATTERN, "Use HH:MM, 24 hour"),
    end: z.string().regex(CLOCK_PATTERN, "Use HH:MM, 24 hour"),
  })
  .strict()
  .refine((q) => q.start !== q.end, { message: "Quiet hours cannot start and end together" });
export type QuietHours = z.infer<typeof QuietHours>;

function minutesOf(clock: string): number {
  const match = CLOCK_PATTERN.exec(clock);
  if (!match) throw new ScheduleError("invalid_quiet_hours", `Not a time of day: ${clock}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

/** True when `now` falls in the quiet window. The window may run past midnight (21:00 to 07:00). */
export function isQuietAt(now: Date, quiet: QuietHours | null | undefined, tz: string): boolean {
  if (!quiet) return false;
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  if (start === end) return false;
  const p = localParts(now, tz);
  const minute = p.hour * 60 + p.minute;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

/** When the quiet window `now` is in ends, or null when `now` is not in quiet hours. */
export function quietHoursEnd(
  now: Date,
  quiet: QuietHours | null | undefined,
  tz: string,
): Date | null {
  if (!quiet || !isQuietAt(now, quiet, tz)) return null;
  const end = minutesOf(quiet.end);
  return nextRunAt(`${end % 60} ${Math.floor(end / 60)} * * *`, tz, now);
}

// ---------------------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------------------

/** Postgres enum notification_type. */
export const NOTIFICATION_TYPES = [
  "cart_ready",
  "items_need_review",
  "run_failed",
  "schedule_skipped",
  "weekly_nudge",
  "pickup_reminder",
  "import_finished",
] as const;
export const NotificationType = z.enum(NOTIFICATION_TYPES);
export type NotificationType = z.infer<typeof NotificationType>;

/** Why a scheduled run did not start. */
export const SCHEDULE_SKIP_REASONS = [
  "no_active_list",
  "connection_not_found",
  "connection_inactive",
  "tier3_unattended",
  "run_in_progress",
  "daily_run_limit",
  "invalid_policy",
  "missed",
  "internal_error",
] as const;
export const ScheduleSkipReason = z.enum(SCHEDULE_SKIP_REASONS);
export type ScheduleSkipReason = z.infer<typeof ScheduleSkipReason>;

const Uuid = z.uuid();

/**
 * What a push carries in its data, and what the outbox stores. Opaque ids and numbers only: a
 * notification never names an item (docs/05). `type` is the payload's own name; the enum value
 * for needs_review is items_need_review (notificationTypeOf).
 */
export const NotificationPayload = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("cart_ready"),
    runId: Uuid,
    storeName: z.string(),
    subtotalUsd: z.number(),
  }),
  z.object({
    type: z.literal("needs_review"),
    runId: Uuid,
    count: z.number().int().min(0),
    /** Set when quiet hours held the push back: the run is waiting for the person. */
    urgent: z.boolean().optional(),
  }),
  z.object({ type: z.literal("run_failed"), runId: Uuid, scheduled: z.boolean() }),
  z.object({
    type: z.literal("schedule_skipped"),
    scheduleId: Uuid,
    reason: ScheduleSkipReason,
    weekStart: z.string().nullable(),
  }),
  z.object({ type: z.literal("weekly_nudge"), weekStart: z.string() }),
  z.object({
    type: z.literal("pickup_reminder"),
    orderId: Uuid,
    runId: Uuid.nullable(),
    slotStart: z.string(),
  }),
  z.object({
    type: z.literal("import_finished"),
    importJobId: Uuid,
    recipeId: Uuid.nullable(),
  }),
]);
export type NotificationPayload = z.infer<typeof NotificationPayload>;

/** The notification_type a payload is stored and filtered under. */
export function notificationTypeOf(payload: Pick<NotificationPayload, "type">): NotificationType {
  return payload.type === "needs_review" ? "items_need_review" : payload.type;
}

/** The payload name for a stored notification_type: the inverse of notificationTypeOf. */
export function payloadTypeOf(type: NotificationType): NotificationPayload["type"] {
  return type === "items_need_review" ? "needs_review" : type;
}

// ---------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------

/**
 * What a schedule stores of the run policy: the keys the editor offers, which are RunPolicy keys
 * (CCR6). `auto_checkout` is not here: a scheduled run never checks out by itself, because no
 * retailer API pays and unattended checkout would need Tier 3 Mode B (docs/04).
 */
export const SchedulePolicy = z
  .object({
    budget_cap_usd: z.number().positive().nullable().optional(),
    per_item_ceiling_usd: z.number().positive().nullable().optional(),
    substitution: RunSubstitution.optional(),
  })
  .strict();
export type SchedulePolicy = z.infer<typeof SchedulePolicy>;

const Timestamp = z.iso.datetime({ offset: true });

/** Postgres table scheduled_runs, as PostgREST returns it. */
export const ScheduledRun = z.object({
  id: Uuid,
  household_id: Uuid,
  cron: z.string(),
  tz: z.string(),
  connection_id: Uuid,
  policy: z.record(z.string(), z.unknown()),
  next_run_at: Timestamp,
  last_enqueued_for: Timestamp.nullable(),
  enabled: z.boolean(),
  created_at: Timestamp,
  updated_at: Timestamp,
});
export type ScheduledRun = z.infer<typeof ScheduledRun>;

/** What a person sets on a schedule. The server computes `next_run_at`. */
export const ScheduleInput = z.object({
  cron: z.string().refine(isValidCron, "Pick a weekday and a time"),
  tz: z.string().refine(isValidTimeZone, "Not a time zone"),
  connection_id: Uuid,
  policy: SchedulePolicy,
  enabled: z.boolean(),
});
export type ScheduleInput = z.infer<typeof ScheduleInput>;
