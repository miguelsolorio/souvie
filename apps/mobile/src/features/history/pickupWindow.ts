// Turning what a person types for a pickup or delivery window into the two timestamps orders keep
// (WS12). The screen asks for a day (chips) and a start and end time of day (text), with no
// date-picker dependency. Times are read in the device's own zone, where the person is. Pure.
import { addDays, isIsoDate } from "@mp/core";
import { shortDayName, shortMonthDay } from "../plan/format";
import { clockLabel } from "./format";

export interface PickupDay {
  iso: string;
  label: string;
}

/** Today and the next six days, for the day chips: "Today", "Tomorrow", then "Thu Nov 5". */
export function pickupDays(today: string): PickupDay[] {
  return Array.from({ length: 7 }, (_, i) => {
    const iso = addDays(today, i);
    const label =
      i === 0 ? "Today" : i === 1 ? "Tomorrow" : `${shortDayName(iso)} ${shortMonthDay(iso)}`;
    return { iso, label };
  });
}

export interface Clock {
  hour: number;
  minute: number;
}

const WITH_MERIDIEM = /^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m?\.?$/i;
const TWENTY_FOUR = /^(\d{1,2}):(\d{2})$/;

/**
 * A time of day as people type it: "4pm", "4:30 pm", "4 p.m.", "16:00". A bare "4" is refused,
 * since it could be either end of the day. Returns null for anything else.
 */
export function parseClock(text: string): Clock | null {
  const value = text.trim().toLowerCase();
  const meridiem = WITH_MERIDIEM.exec(value);
  if (meridiem) {
    const hour = Number(meridiem[1]);
    const minute = Number(meridiem[2] ?? "0");
    if (hour < 1 || hour > 12 || minute > 59) return null;
    const pm = meridiem[3] === "p";
    return { hour: (hour % 12) + (pm ? 12 : 0), minute };
  }
  const twentyFour = TWENTY_FOUR.exec(value);
  if (twentyFour) {
    const hour = Number(twentyFour[1]);
    const minute = Number(twentyFour[2]);
    return hour <= 23 && minute <= 59 ? { hour, minute } : null;
  }
  return null;
}

export const START_HINT = "Enter a time like 4:00 pm.";

export type WindowResult =
  | { ok: true; slotStart: string | null; slotEnd: string | null }
  | { ok: false; field: "start" | "end"; message: string };

function at(day: string, clock: Clock): Date {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  return new Date(y, m - 1, d, clock.hour, clock.minute, 0, 0);
}

/**
 * The window for a day and two times of day. Both blank is no window. An end needs a start, and
 * must come after it that day.
 */
export function buildWindow(input: { day: string; start: string; end: string }): WindowResult {
  const startText = input.start.trim();
  const endText = input.end.trim();
  if (startText === "" && endText === "") return { ok: true, slotStart: null, slotEnd: null };
  if (!isIsoDate(input.day)) return { ok: false, field: "start", message: "Pick a day." };

  const start = parseClock(startText);
  if (!start) {
    return {
      ok: false,
      field: "start",
      message: startText === "" ? "Enter when the window starts." : START_HINT,
    };
  }
  const from = at(input.day, start);
  if (endText === "") return { ok: true, slotStart: from.toISOString(), slotEnd: null };

  const end = parseClock(endText);
  if (!end) return { ok: false, field: "end", message: START_HINT };
  const to = at(input.day, end);
  if (!(to.getTime() > from.getTime())) {
    return { ok: false, field: "end", message: "The end has to come after the start." };
  }
  return { ok: true, slotStart: from.toISOString(), slotEnd: to.toISOString() };
}

/** The clock text for a stored timestamp, to prefill an edit: "4:00 pm". */
export function clockText(instant: string): string {
  return clockLabel(new Date(instant));
}
