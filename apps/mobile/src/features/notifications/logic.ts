// Pure logic for the notification settings (WS11): the rows, the quiet hours draft and its words.
// No React Native here, so Vitest runs it.
import type { NotificationType, QuietHours } from "@mp/core";

export interface NotificationRow {
  type: NotificationType;
  label: string;
  help: string;
}

/** Every push, in the order a household meets them. No row ever names an item. */
export const NOTIFICATION_ROWS: readonly NotificationRow[] = [
  {
    type: "cart_ready",
    label: "Your cart is ready",
    help: "A run filled your store cart. You review it, then pay in the store's app.",
  },
  {
    type: "items_need_review",
    label: "Items need your call",
    help: "The shopper wants you to check a few items before it fills the cart.",
  },
  {
    type: "run_failed",
    label: "A shopping run stops",
    help: "A run could not finish, so nothing more will happen until you look.",
  },
  {
    type: "schedule_skipped",
    label: "A scheduled run is skipped",
    help: "There was no grocery list for the week, or the store could not be reached.",
  },
  {
    type: "weekly_nudge",
    label: "Plan next week",
    help: "A Thursday evening reminder when next week has no plan yet.",
  },
  {
    type: "pickup_reminder",
    label: "Pickup reminder",
    help: "An hour before the pickup window you recorded.",
  },
  {
    type: "import_finished",
    label: "A recipe import finishes",
    help: "Only for imports that take a while.",
  },
];

export interface QuietDraft {
  enabled: boolean;
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
}

/** 21:00 to 07:00: the window most people mean by "overnight". */
export const DEFAULT_QUIET: Omit<QuietDraft, "enabled"> = {
  startHour: 21,
  startMinute: 0,
  endHour: 7,
  endMinute: 0,
};

function clock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function parseClock(value: string): { hour: number; minute: number } {
  const [hour = "0", minute = "0"] = value.split(":");
  return { hour: Number(hour), minute: Number(minute) };
}

export function quietDraftOf(quiet: QuietHours | null): QuietDraft {
  if (!quiet) return { enabled: false, ...DEFAULT_QUIET };
  const start = parseClock(quiet.start);
  const end = parseClock(quiet.end);
  return {
    enabled: true,
    startHour: start.hour,
    startMinute: start.minute,
    endHour: end.hour,
    endMinute: end.minute,
  };
}

export type QuietResult =
  | { ok: true; quietHours: QuietHours | null }
  | { ok: false; error: string };

/** What to save: null when quiet hours are off, otherwise two different times. */
export function toQuietHours(draft: QuietDraft): QuietResult {
  if (!draft.enabled) return { ok: true, quietHours: null };
  const start = clock(draft.startHour, draft.startMinute);
  const end = clock(draft.endHour, draft.endMinute);
  if (start === end) {
    return { ok: false, error: "Quiet hours need a start and an end that are different times." };
  }
  return { ok: true, quietHours: { start, end } };
}

/** True when two drafts would save the same thing. */
export function sameQuiet(a: QuietDraft, b: QuietDraft): boolean {
  if (!a.enabled && !b.enabled) return true;
  return (
    a.enabled === b.enabled &&
    a.startHour === b.startHour &&
    a.startMinute === b.startMinute &&
    a.endHour === b.endHour &&
    a.endMinute === b.endMinute
  );
}
