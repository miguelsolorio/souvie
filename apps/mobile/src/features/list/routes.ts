// Routes the grocery list screens link to and from (WS05).

export const LIST_ROUTE = "/list";
export const PANTRY_ROUTE = "/pantry";
export const STORE_MODE_ROUTE = "/list/store-mode";

/** The list for a week. Omit `weekStart` for the week the planner was showing, else this week. */
export function listRoute(weekStart?: string): string {
  return weekStart ? `${LIST_ROUTE}?week=${weekStart}` : LIST_ROUTE;
}

/** One list by id. */
export const listByIdRoute = (id: string) => `${LIST_ROUTE}/${id}`;

/** In-store mode for a list. Only an id goes in the URL. */
export function storeModeRoute(listId?: string): string {
  return listId ? `${STORE_MODE_ROUTE}?list=${listId}` : STORE_MODE_ROUTE;
}
