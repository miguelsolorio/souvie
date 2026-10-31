// Which week the planner was showing when the person tapped "Generate list". The planner's route
// is /plan with an optional ?week=; the list screens open on the same week so "Generate list" on
// next week's plan builds next week's list, not this week's. The planner and the list screens sit
// in one Stack, so the planner's route (and its params) is still in the navigation state.
import { isIsoDate, weekStartFor } from "@mp/core";

export interface NavRoute {
  name?: string;
  params?: Record<string, unknown> | undefined;
  state?: NavState | undefined;
}
export interface NavState {
  routes?: readonly NavRoute[] | undefined;
}

/** The last route called `name` anywhere in a (possibly nested) navigation state, or null. */
export function findLastRoute(state: NavState | undefined, name: string): NavRoute | null {
  const routes = state?.routes ?? [];
  for (let index = routes.length - 1; index >= 0; index--) {
    const route = routes[index];
    if (!route) continue;
    if (route.name === name) return route;
    const inside = findLastRoute(route.state, name);
    if (inside) return inside;
  }
  return null;
}

/**
 * The Monday of the week the planner shows, from its route params, or null when the planner is not
 * in the stack (a deep link straight to the list) or shows this week with no param.
 */
export function plannerWeekFrom(state: NavState | undefined): string | null {
  const week = findLastRoute(state, "plan/index")?.params?.week;
  return typeof week === "string" && isIsoDate(week) ? weekStartFor(week) : null;
}
