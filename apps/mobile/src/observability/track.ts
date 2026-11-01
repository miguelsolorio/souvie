// The seven core-loop events (WS15 brief), one typed function each:
//
//   track.onboardingCompleted({ steps_completed: 8, store_connected: true })
//   track.planCreated({ entries: 5, source: "ai" })
//   track.listBuilt({ items: 31, pantry_excluded: 6 })
//   track.runStarted({ retailer: "kroger", trigger: "manual" })
//   track.cartReady({ retailer: "kroger", items: 29, subtotal_bucket: "100_150" })
//   track.runApproved({ retailer: "kroger", review_edits: 2 })
//   track.checkoutCompleted({ retailer: "safeway", tier: 3 })
//
// Event names and property keys are exactly the brief's (events.ts). A property that is not on an
// event's list is dropped before it is sent, and a call never throws: analytics must not break
// a screen. Future workstreams add their events to events.ts and here, the same way.
import { type EventName, type EventProps, sanitizeProps } from "./events";
import { getPostHog } from "./posthog";

function send<E extends EventName>(event: E, props: EventProps[E]): void {
  try {
    getPostHog()?.capture(event, sanitizeProps(event, props));
  } catch {
    // Analytics never breaks the app.
  }
}

export const track = {
  onboardingCompleted: (props: EventProps["onboarding_completed"]) =>
    send("onboarding_completed", props),
  planCreated: (props: EventProps["plan_created"]) => send("plan_created", props),
  listBuilt: (props: EventProps["list_built"]) => send("list_built", props),
  runStarted: (props: EventProps["run_started"]) => send("run_started", props),
  cartReady: (props: EventProps["cart_ready"]) => send("cart_ready", props),
  runApproved: (props: EventProps["run_approved"]) => send("run_approved", props),
  checkoutCompleted: (props: EventProps["checkout_completed"]) => send("checkout_completed", props),
} as const;
