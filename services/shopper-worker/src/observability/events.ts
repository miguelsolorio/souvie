// The product events (WS15 brief): exactly these seven for the core loop, with exactly these
// properties. Event names and property keys are the contract with PostHog; the app has the same
// table in apps/mobile/src/observability/events.ts (events.test.ts compares the two).
//
// What a property may hold (docs/05 §Privacy): counts, booleans and small enums. Never a recipe
// title, a product name, a list line, an address, an email, or a dollar amount. A price is a bucket.

import type { RetailerId } from "@mp/retailers";

export const EVENT_NAMES = [
  "onboarding_completed",
  "plan_created",
  "list_built",
  "run_started",
  "cart_ready",
  "run_approved",
  "checkout_completed",
] as const;
export type EventName = (typeof EVENT_NAMES)[number];

export type Retailer = RetailerId;
export type SubtotalBucket = "under_50" | "50_100" | "100_150" | "150_200" | "over_200";

export interface EventProps {
  onboarding_completed: { steps_completed: number; store_connected: boolean };
  plan_created: { entries: number; source: "ai" | "manual" };
  list_built: { items: number; pantry_excluded: number };
  run_started: { retailer: Retailer; trigger: "manual" | "scheduled" };
  cart_ready: { retailer: Retailer; items: number; subtotal_bucket: SubtotalBucket };
  run_approved: { retailer: Retailer; review_edits: number };
  checkout_completed: { retailer: Retailer; tier: 1 | 2 | 3 };
}

/** The property keys each event may carry. Anything else is dropped before it is sent. */
export const EVENT_KEYS: { [E in EventName]: ReadonlyArray<keyof EventProps[E] & string> } = {
  onboarding_completed: ["steps_completed", "store_connected"],
  plan_created: ["entries", "source"],
  list_built: ["items", "pantry_excluded"],
  run_started: ["retailer", "trigger"],
  cart_ready: ["retailer", "items", "subtotal_bucket"],
  run_approved: ["retailer", "review_edits"],
  checkout_completed: ["retailer", "tier"],
};

/** Totals are bucketed, so no event carries what a household spent. */
export function subtotalBucket(usd: number | null | undefined): SubtotalBucket {
  const amount = typeof usd === "number" && Number.isFinite(usd) ? usd : 0;
  if (amount < 50) return "under_50";
  if (amount < 100) return "50_100";
  if (amount < 150) return "100_150";
  if (amount < 200) return "150_200";
  return "over_200";
}

/**
 * The properties of an event with every key outside its list dropped, and every value that is not
 * a string, a finite number or a boolean. A caller that adds a field by mistake loses it here, not
 * in PostHog.
 */
export function sanitizeProps<E extends EventName>(
  event: E,
  props: object,
): Record<string, unknown> {
  const allowed: ReadonlyArray<string> = EVENT_KEYS[event];
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (!allowed.includes(key)) continue;
    if (typeof value === "string" || typeof value === "boolean") out[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}
