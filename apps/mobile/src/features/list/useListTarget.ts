import { isIsoDate, isoDateOf, weekStartFor } from "@mp/core";
import { useLocalSearchParams } from "expo-router";
import { usePlannerWeek } from "./usePlannerWeek";

/**
 * Which list a screen opens: the one for `?week=`, else for the week the planner was showing, else
 * this week; or a specific list by `?list=`. The list screens and store mode share it.
 */
export function useListTarget(): { weekStart: string; listId: string | null } {
  const params = useLocalSearchParams<{ week?: string; list?: string }>();
  const plannerWeek = usePlannerWeek();
  const thisWeek = weekStartFor(isoDateOf(new Date()));
  const weekStart =
    params.week && isIsoDate(params.week) ? weekStartFor(params.week) : (plannerWeek ?? thisWeek);
  return { weekStart, listId: params.list ?? null };
}
