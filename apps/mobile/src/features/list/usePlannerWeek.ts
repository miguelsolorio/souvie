import { useRootNavigationState } from "expo-router";
import { type NavState, plannerWeekFrom } from "./plannerWeek";

/** The Monday of the week the planner is showing, or null (see plannerWeek.ts). */
export function usePlannerWeek(): string | null {
  const state = useRootNavigationState();
  return plannerWeekFrom(state as NavState | undefined);
}
