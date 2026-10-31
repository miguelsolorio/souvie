// The two run notifications (WS09; WS11 adds the rest): "Cart ready at QFC Duvall, $142.17. Review
// and pay." on cart_ready and "3 items need your call" on needs_review, through Expo's push API.
//
// docs/05 §Privacy: a notification carries the subtotal and the store, never an item name. The
// payload the app routes on is { type, runId, ... } with opaque ids only.
import type { PushPayload } from "@mp/agent";

export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
/** Expo takes at most 100 messages per request. */
const CHUNK = 100;

export interface PushText {
  title: string;
  body: string;
}

export function pushText(payload: PushPayload): PushText {
  if (payload.type === "cart_ready") {
    return {
      title: "Cart ready",
      body: `Cart ready at ${payload.storeName}, $${payload.subtotalUsd.toFixed(2)}. Review and pay.`,
    };
  }
  if (payload.count === 0) {
    return { title: "Review your cart", body: "Your cart is ready to review." };
  }
  return {
    title: "Review your cart",
    body: `${payload.count} item${payload.count === 1 ? " needs" : "s need"} your call`,
  };
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

export interface SendOptions {
  fetch?: typeof fetch;
  /** EXPO_PUSH_ACCESS_TOKEN, when the Expo project requires one. */
  accessToken?: string | undefined;
}

/** Sends one payload to every token. Never throws: a notification must not fail a run. */
export async function sendPush(
  tokens: readonly string[],
  payload: PushPayload,
  options: SendOptions = {},
): Promise<SendResult> {
  const result: SendResult = { sent: 0, invalid: [], errors: [] };
  const valid = [...new Set(tokens)].filter((t) => /^(Exponent|Expo)PushToken\[.+\]$/.test(t));
  if (valid.length === 0) return result;
  const text = pushText(payload);
  const doFetch = options.fetch ?? fetch;
  for (let i = 0; i < valid.length; i += CHUNK) {
    const chunk = valid.slice(i, i + CHUNK);
    const body = chunk.map((to) => ({ to, ...text, data: payload, sound: "default" }));
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
