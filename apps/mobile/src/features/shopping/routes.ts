// Routes the shopping run screens link to and from (WS09), and where a tapped push goes (WS09, WS11).
// Only opaque ids go in a URL.
import { isIsoDate } from "@mp/core";
import { planRoute } from "../plan/routes";
import { SCHEDULES_ROUTE } from "../schedules/routes";

export const SHOPPING_ROUTE = "/shopping";

export const runRoute = (runId: string) => `${SHOPPING_ROUTE}/${runId}`;

const ID = /^[0-9a-f-]{36}$/i;

function idOf(value: unknown): string | null {
  return typeof value === "string" && ID.test(value) ? value : null;
}

/**
 * Where a tap on a push goes, from its data payload, or null for anything that is not ours:
 *   cart_ready, needs_review, run_failed   the run
 *   pickup_reminder                         the run it came from, else the list of runs
 *   schedule_skipped                        the schedules, to see why and fix it
 *   weekly_nudge                            the planner, at the week with nothing in it
 *   import_finished                         the recipe, else the recipe list
 */
export function routeForPush(data: unknown): string | null {
  const payload = data as {
    type?: unknown;
    runId?: unknown;
    weekStart?: unknown;
    recipeId?: unknown;
  } | null;
  switch (payload?.type) {
    case "cart_ready":
    case "needs_review":
    case "run_failed": {
      const runId = idOf(payload.runId);
      return runId ? runRoute(runId) : null;
    }
    case "pickup_reminder": {
      const runId = idOf(payload.runId);
      return runId ? runRoute(runId) : SHOPPING_ROUTE;
    }
    case "schedule_skipped":
      return SCHEDULES_ROUTE;
    case "weekly_nudge":
      return typeof payload.weekStart === "string" && isIsoDate(payload.weekStart)
        ? planRoute(payload.weekStart)
        : planRoute();
    case "import_finished": {
      const recipeId = idOf(payload.recipeId);
      return recipeId ? `/recipes/${recipeId}` : "/recipes";
    }
    default:
      return null;
  }
}
