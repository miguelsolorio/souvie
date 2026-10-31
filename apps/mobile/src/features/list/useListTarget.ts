import { isIsoDate, isoDateOf, weekStartFor } from "@mp/core";
import { useLocalSearchParams } from "expo-router";
import { usePlannerWeek } from "./usePlannerWeek";

/**
 * Which list a screen opens: the one for `?week=`, else for the week the planner was showing, else
 * this week; or a specific list by `?list=`. `?build=1` (what the planner's "Generate list" opens)
 * asks the list screen to build the list on arrival when the week has none. The list screens and
 * store mode share it.
 */
export function useListTarget(): { weekStart: string; listId: string | null; autoBuild: boolean } {
  const params = useLocalSearchParams<{ week?: string; list?: string; build?: string }>();
  const plannerWeek = usePlannerWeek();
  const thisWeek = weekStartFor(isoDateOf(new Date()));
  const weekStart =
    params.week && isIsoDate(params.week) ? weekStartFor(params.week) : (plannerWeek ?? thisWeek);
  return { weekStart, listId: params.list ?? null, autoBuild: params.build === "1" };
}
