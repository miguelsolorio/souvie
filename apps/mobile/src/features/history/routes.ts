// Routes the History screens link to and from (WS12). Only opaque ids go in a URL.

export const HISTORY_ROUTE = "/history";

export const HISTORY_TABS = ["meals", "spend", "bought"] as const;
export type HistoryTab = (typeof HISTORY_TABS)[number];

/** The tab a `?tab=` parameter names, or Meals for anything else. */
export function parseTab(value: unknown): HistoryTab {
  const first = Array.isArray(value) ? value[0] : value;
  return HISTORY_TABS.find((tab) => tab === first) ?? "meals";
}

/** History, optionally on a tab. */
export function historyRoute(tab?: HistoryTab): string {
  return tab && tab !== "meals" ? `${HISTORY_ROUTE}?tab=${tab}` : HISTORY_ROUTE;
}

/** One order. */
export const orderRoute = (orderId: string) => `${HISTORY_ROUTE}/orders/${orderId}`;
