// Pure logic for the schedule screens (WS11): the editor's draft, its validation, the next-run
// preview and the words for a schedule. No React Native here, so Vitest runs it.
//
// The preview is `nextRunAt` from @mp/core, the same function whose results the scheduler's SQL
// (public.scheduled_run_next) is tested against, so what the editor shows is when the run starts.
import {
  type Cadence,
  cadenceToCron,
  cronToCadence,
  DEFAULT_SCHEDULE_CADENCE,
  DEFAULT_TIME_ZONE,
  type IsoWeekday,
  isValidTimeZone,
  nextRunAt,
  parseCron,
  type RunSubstitution,
  type ScheduledRun,
  type ScheduleInput,
  WEEKDAY_NAMES,
} from "@mp/core";
import type { ScheduleConnection } from "@mp/db";

export const NEW_SCHEDULE_ID = "new";

/** The zone this phone is in, or undefined when the runtime cannot say. */
export function deviceTimeZone(): string | undefined {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && isValidTimeZone(zone) ? zone : undefined;
  } catch {
    return undefined;
  }
}

/** What a person sets in the editor. Hour is 0 to 23; the screen shows it on a 12 hour clock. */
export interface ScheduleDraft {
  weekday: IsoWeekday;
  hour: number;
  minute: number;
  connectionId: string | null;
  /** USD, as typed. Empty means no cap. */
  budgetText: string;
  substitution: RunSubstitution;
  enabled: boolean;
  tz: string;
  /** A per-item ceiling set outside the editor, kept as it is when the schedule is saved. */
  perItemCeilingUsd: number | null;
}

/** Saturday 9:00 for the week starting Monday: the suggestion everyone starts from. */
export function newDraft(options: {
  tz?: string | undefined;
  connectionId?: string | null | undefined;
}): ScheduleDraft {
  const { weekday, hour, minute } = DEFAULT_SCHEDULE_CADENCE;
  return {
    weekday,
    hour,
    minute,
    connectionId: options.connectionId ?? null,
    budgetText: "",
    substitution: "same_brand",
    enabled: true,
    tz: options.tz && isValidTimeZone(options.tz) ? options.tz : DEFAULT_TIME_ZONE,
    perItemCeilingUsd: null,
  };
}

/**
 * The draft for a stored schedule, or null when its cron is one the editor cannot show (more than
 * one weekday, say): such a schedule can still be switched off or deleted, not edited here.
 */
export function draftOf(schedule: ScheduledRun): ScheduleDraft | null {
  const cadence = cronToCadence(schedule.cron);
  if (!cadence) return null;
  const policy = schedule.policy as {
    budget_cap_usd?: unknown;
    per_item_ceiling_usd?: unknown;
    substitution?: unknown;
  };
  const cap = typeof policy.budget_cap_usd === "number" ? policy.budget_cap_usd : null;
  const ceiling =
    typeof policy.per_item_ceiling_usd === "number" ? policy.per_item_ceiling_usd : null;
  const substitution =
    policy.substitution === "none" || policy.substitution === "any"
      ? policy.substitution
      : "same_brand";
  return {
    weekday: cadence.weekday,
    hour: cadence.hour,
    minute: cadence.minute,
    connectionId: schedule.connection_id,
    budgetText: cap === null ? "" : String(cap),
    substitution,
    enabled: schedule.enabled,
    tz: schedule.tz,
    perItemCeilingUsd: ceiling,
  };
}

// ---------------------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------------------

export interface Clock12 {
  /** 1 to 12. */
  hour: number;
  pm: boolean;
}

export function to12h(hour24: number): Clock12 {
  const hour = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return { hour, pm: hour24 >= 12 };
}

export function from12h(clock: Clock12): number {
  return (clock.hour % 12) + (clock.pm ? 12 : 0);
}

/** "9:00 AM". */
export function clockText(hour24: number, minute: number): string {
  const { hour, pm } = to12h(hour24);
  return `${hour}:${String(minute).padStart(2, "0")} ${pm ? "PM" : "AM"}`;
}

// ---------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------

export type BudgetResult = { ok: true; value: number | null } | { ok: false; error: string };

/** The budget cap as typed: empty is no cap, otherwise dollars above zero (cents allowed). */
export function parseBudget(text: string): BudgetResult {
  const trimmed = text.trim().replace(/^\$/, "").replace(/,/g, "");
  if (trimmed === "") return { ok: true, value: null };
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    return { ok: false, error: "Enter a dollar amount, like 150, or leave it empty for no cap." };
  }
  const value = Number(trimmed);
  if (!(value > 0)) return { ok: false, error: "The cap has to be more than $0." };
  if (value > 100_000) return { ok: false, error: "That cap is more than a cart can reach." };
  return { ok: true, value };
}

export interface DraftErrors {
  connection?: string;
  budget?: string;
  tz?: string;
}

export type DraftResult = { ok: true; input: ScheduleInput } | { ok: false; errors: DraftErrors };

export function toInput(draft: ScheduleDraft): DraftResult {
  const errors: DraftErrors = {};
  if (!draft.connectionId) errors.connection = "Pick the store this schedule shops at.";
  const budget = parseBudget(draft.budgetText);
  if (!budget.ok) errors.budget = budget.error;
  if (!isValidTimeZone(draft.tz)) errors.tz = "That time zone is not valid.";
  if (Object.keys(errors).length > 0 || !draft.connectionId || !budget.ok) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    input: {
      cron: cadenceToCron({ weekday: draft.weekday, hour: draft.hour, minute: draft.minute }),
      tz: draft.tz,
      connection_id: draft.connectionId,
      policy: {
        budget_cap_usd: budget.value,
        ...(draft.perItemCeilingUsd === null
          ? {}
          : { per_item_ceiling_usd: draft.perItemCeilingUsd }),
        substitution: draft.substitution,
      },
      enabled: draft.enabled,
    },
  };
}

// ---------------------------------------------------------------------------------------
// The words
// ---------------------------------------------------------------------------------------

function plain(text: string): string {
  return text.replace(/[  ]/g, " ");
}

/** "Los Angeles" for America/Los_Angeles. */
export function zoneLabel(tz: string): string {
  const last = tz.split("/").pop() ?? tz;
  return last.replace(/_/g, " ");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Nov 9" for 2026-11-09: the week a run shops for. */
export function weekOfText(isoDate: string): string {
  const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(isoDate);
  const month = match ? MONTHS[Number(match[1]) - 1] : undefined;
  return match && month ? `${month} ${Number(match[2])}` : isoDate;
}

/** "Sat, Nov 7 at 9:00 AM", on the wall clock of `tz`. */
export function formatRun(date: Date, tz: string): string {
  try {
    const day = plain(
      new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        weekday: "short",
        month: "short",
        day: "numeric",
      }).format(date),
    );
    const time = plain(
      new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour: "numeric",
        minute: "2-digit",
      }).format(date),
    );
    return `${day} at ${time}`;
  } catch {
    return date.toISOString();
  }
}

/** The next time a draft fires after `now`, or null while the draft is not valid. */
export function previewNextRun(draft: ScheduleDraft, now: Date): Date | null {
  if (!isValidTimeZone(draft.tz)) return null;
  try {
    const cron = cadenceToCron({ weekday: draft.weekday, hour: draft.hour, minute: draft.minute });
    return nextRunAt(cron, draft.tz, now);
  } catch {
    return null;
  }
}

/** "Saturdays at 9:00 AM" for a cadence the editor can show; the cron itself for any other. */
export function describeSchedule(cron: string): string {
  const cadence: Cadence | null = cronToCadence(cron);
  if (cadence)
    return `${WEEKDAY_NAMES[cadence.weekday]}s at ${clockText(cadence.hour, cadence.minute)}`;
  try {
    const spec = parseCron(cron);
    const time = clockText(spec.hour, spec.minute);
    if (spec.weekdays === null) return `Every day at ${time}`;
    return `${spec.weekdays.map((d) => WEEKDAY_NAMES[d].slice(0, 3)).join(", ")} at ${time}`;
  } catch {
    return cron;
  }
}

export const SUBSTITUTION_LABEL: Readonly<Record<RunSubstitution, string>> = {
  none: "No swaps",
  same_brand: "Same brand",
  any: "Any brand",
};

export const SUBSTITUTION_HELP: Readonly<Record<RunSubstitution, string>> = {
  none: "If an item is out of stock it is left for you.",
  same_brand: "A different size of the same brand is fine.",
  any: "Another brand is fine when the first choice is out.",
};

/** A store connection as a choice in the editor. A reason means it cannot be picked. */
export interface ConnectionChoice {
  id: string;
  label: string;
  reason: string | null;
}

export function connectionChoices(connections: readonly ScheduleConnection[]): ConnectionChoice[] {
  return connections.map((connection) => {
    const name = connection.storeName ?? "Your store account";
    let reason: string | null = null;
    if (!connection.unattended) {
      reason = "This store runs on your phone, so it cannot shop on its own. Use Shop this list.";
    } else if (connection.status === "needs_reauth") {
      reason = "Needs a new sign-in. Reconnect it in household settings.";
    } else if (connection.status === "revoked") {
      reason = "Disconnected.";
    }
    return { id: connection.id, label: name, reason };
  });
}

/** The connection a new schedule starts with: the first one that can run by itself. */
export function defaultConnectionId(connections: readonly ScheduleConnection[]): string | null {
  return connectionChoices(connections).find((c) => c.reason === null)?.id ?? null;
}

export const WEEKDAYS: ReadonlyArray<{ value: IsoWeekday; short: string; long: string }> = (
  [1, 2, 3, 4, 5, 6, 7] as const
).map((value) => ({
  value,
  short: WEEKDAY_NAMES[value].slice(0, 3),
  long: WEEKDAY_NAMES[value],
}));
