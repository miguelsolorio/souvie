// Routes the shopping run screens link to and from (WS09). Only an opaque run id goes in a URL.

export const SHOPPING_ROUTE = "/shopping";

export const runRoute = (runId: string) => `${SHOPPING_ROUTE}/${runId}`;

/** The run a push notification opens, from its data payload, or null for anything else. */
export function routeForPush(data: unknown): string | null {
  const payload = data as { type?: unknown; runId?: unknown } | null;
  if (!payload || (payload.type !== "cart_ready" && payload.type !== "needs_review")) return null;
  return typeof payload.runId === "string" && /^[0-9a-f-]{36}$/i.test(payload.runId)
    ? runRoute(payload.runId)
    : null;
}
