// What the worker pushes (WS09's two run notifications; WS11 adds the rest) and how it reaches Expo.
//
// docs/05 §Privacy: a notification carries the subtotal and the store, never an item name. The
// payload the app routes on is `{ type, ...opaque ids }` (core.NotificationPayload).
//
// R19: no store API pays or picks a slot, so the cart_ready text says what happens next, and
// nothing here ever says an order was placed.
import type { NotificationPayload } from "@mp/core";

export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
/** Expo takes at most 100 messages per request. */
const CHUNK = 100;

export interface PushText {
  title: string;
  body: string;
}

export interface PushTextOptions {
  /** The household's zone, for a time of day in the text. Defaults to America/Los_Angeles. */
  timeZone?: string;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** "2026-11-09" as "Nov 9". Anything else is returned as it came. */
export function shortDate(isoDate: string): string {
  const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(isoDate);
  const month = match ? MONTHS[Number(match[1]) - 1] : undefined;
  return match && month ? `${month} ${Number(match[2])}` : isoDate;
}

function clock(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "soon";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  } catch {
    return "soon";
  }
}

/** The line a skipped schedule gives for each reason, in words for the household. */
export function skipText(reason: string, weekStart: string | null): string {
  switch (reason) {
    case "no_active_list":
      return weekStart
        ? `There is no grocery list for the week of ${shortDate(weekStart)}, so your scheduled run was skipped. Build the list, then tap Shop this list.`
        : "There is no grocery list for the coming week, so your scheduled run was skipped.";
    case "connection_not_found":
    case "connection_inactive":
      return "Your store account needs attention, so your scheduled run was skipped. Reconnect it in settings.";
    case "tier3_unattended":
      return "Your store runs on your phone, so a scheduled run cannot start on its own. Open the app to shop.";
    case "run_in_progress":
      return "A run for this week's list was already going, so your scheduled run was skipped.";
    case "daily_run_limit":
      return "That is the most runs for one day, so your scheduled run was skipped.";
    case "invalid_policy":
      return "Your scheduled run has shopping rules that are not valid, so it was skipped. Check the schedule.";
    case "missed":
      return "Your scheduled run did not start on time and was skipped. Check the schedule.";
    default:
      return "Your scheduled run could not start. Check the schedule.";
  }
}

export function pushText(payload: NotificationPayload, options: PushTextOptions = {}): PushText {
  switch (payload.type) {
    case "cart_ready":
      return {
        title: "Cart ready",
        body: `Your cart at ${payload.storeName} is ready ($${payload.subtotalUsd.toFixed(2)}). Tap to review, then pick a pickup time and pay in the store's app.`,
      };
    case "needs_review":
      if (payload.count === 0) {
        return { title: "Review your cart", body: "Your cart is ready to review." };
      }
      return {
        title: "Review your cart",
        body: `${payload.count} item${payload.count === 1 ? " needs" : "s need"} your call`,
      };
    case "run_failed":
      return {
        title: "Shopping stopped",
        body: payload.scheduled
          ? "Your scheduled shopping run stopped. Tap to see why."
          : "Your shopping run stopped. Tap to see why.",
      };
    case "schedule_skipped":
      return { title: "Scheduled run skipped", body: skipText(payload.reason, payload.weekStart) };
    case "weekly_nudge":
      return {
        title: "Plan next week",
        body: `Nothing is planned for the week of ${shortDate(payload.weekStart)} yet. Plan it so the list is ready when you shop.`,
      };
    case "pickup_reminder":
      return {
        title: "Pickup soon",
        body: `Your pickup window starts at ${clock(payload.slotStart, options.timeZone ?? "America/Los_Angeles")}.`,
      };
    case "import_finished":
      return {
        title: "Recipe imported",
        body: payload.recipeId
          ? "Your recipe import finished. Tap to open it."
          : "Your recipe import finished.",
      };
  }
}

export interface ExpoTicket {
  status: "ok" | "error";
  message?: string;
  details?: { error?: string };
}

export interface SendResult {
  sent: number;
  /** Tokens Expo says no longer reach a device (DeviceNotRegistered). */
  invalid: string[];
  errors: string[];
}

export interface SendOptions extends PushTextOptions {
  fetch?: typeof fetch;
  /** EXPO_PUSH_ACCESS_TOKEN, when the Expo project requires one. */
  accessToken?: string | undefined;
}

/** Sends one payload to every token. Never throws: a notification must not fail a run. */
export async function sendPush(
  tokens: readonly string[],
  payload: NotificationPayload,
  options: SendOptions = {},
): Promise<SendResult> {
  const result: SendResult = { sent: 0, invalid: [], errors: [] };
  const valid = [...new Set(tokens)].filter((t) => /^(Exponent|Expo)PushToken\[.+\]$/.test(t));
  if (valid.length === 0) return result;
  const text = pushText(payload, options);
  // A review that was held back by quiet hours still needs the person: send it with high priority.
  const priority =
    payload.type === "needs_review" && payload.urgent === true ? { priority: "high" } : {};
  const doFetch = options.fetch ?? fetch;
  for (let i = 0; i < valid.length; i += CHUNK) {
    const chunk = valid.slice(i, i + CHUNK);
    const body = chunk.map((to) => ({ to, ...text, data: payload, sound: "default", ...priority }));
    try {
      const response = await doFetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(options.accessToken ? { Authorization: `Bearer ${options.accessToken}` } : {}),
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        result.errors.push(`expo push answered ${response.status}`);
        continue;
      }
      const json = (await response.json()) as { data?: ExpoTicket[] };
      (json.data ?? []).forEach((ticket, index) => {
        if (ticket.status === "ok") result.sent += 1;
        else if (ticket.details?.error === "DeviceNotRegistered") {
          const token = chunk[index];
          if (token) result.invalid.push(token);
        } else result.errors.push(ticket.message ?? "push ticket error");
      });
    } catch (err) {
      result.errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  return result;
}
