import { comingWeekStart, type SuggestPlanResponse } from "@mp/core";
import { fetchMealPlan, fetchMealPlanEntries, useHousehold, useSupabase } from "@mp/db";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { type RecheckResult, recheckPlans } from "./planRecheck";
import { SuggestError, suggestCalibration, suggestPlan } from "./suggestApi";

export interface SuggestWeekInput {
  /** A Monday, YYYY-MM-DD. Defaults to the coming week. */
  weekStart?: string;
  mode: "draft" | "replace";
  /** Dinners to plan. Defaults to the person's dinners per week. */
  dinners?: number;
  /** With mode "replace": replace only this night. */
  date?: string;
}

/**
 * Asks the `suggest` function for a week of dinners in the active household (WS06). `draft` plans
 * the week or returns the plan it already has; `replace` plans again, or one night when `date` is
 * given. The planner (WS04) uses this for "swap with a suggestion". A success refreshes the
 * planner's queries.
 */
export function useSuggestWeek() {
  const client = useSupabase();
  const household = useHousehold();
  const queryClient = useQueryClient();
  const householdId = household.data?.id;

  return useMutation({
    mutationFn: async (input: SuggestWeekInput): Promise<SuggestPlanResponse> => {
      if (!householdId) throw new SuggestError("no_household");
      return suggestPlan(client, {
        householdId,
        weekStart: input.weekStart ?? comingWeekStart(new Date()),
        mode: input.mode,
        ...(input.dinners ? { dinners: input.dinners } : {}),
        ...(input.date ? { date: input.date } : {}),
      });
    },
    onSuccess: () => {
      // The planner (WS04) keys its queries ['meal-plan', householdId, weekStart].
      void queryClient.invalidateQueries({ queryKey: ["meal-plan", householdId] });
    },
  });
}

/**
 * Re-checks the planned weeks (this one and the coming one) against the household's allergies and
 * diets, through `useSuggestWeek`'s `draft`. A week that already has dinners comes back with any
 * dinner that no longer fits replaced or removed; a week with none is skipped. Returns a function
 * that resolves with what changed and throws when a call fails.
 */
export function usePlanRecheck() {
  const client = useSupabase();
  const household = useHousehold();
  const { mutateAsync } = useSuggestWeek();
  const householdId = household.data?.id;

  return useCallback(async (): Promise<RecheckResult> => {
    if (!householdId) throw new SuggestError("no_household");
    return recheckPlans(
      {
        hasDinners: async (weekStart) => {
          const plan = await fetchMealPlan(client, householdId, weekStart);
          if (!plan) return false;
          const entries = await fetchMealPlanEntries(client, plan.id);
          return entries.some((entry) => entry.slot === "dinner");
        },
        draft: (weekStart) => mutateAsync({ mode: "draft", weekStart }),
      },
      new Date(),
    );
  }, [client, householdId, mutateAsync]);
}

export const calibrationQueryKey = (householdId: string | undefined, weekStart: string) =>
  ["calibration-cards", householdId, weekStart] as const;

/**
 * The twelve recipes for the swipe screen. Fetched once per visit and never persisted: they are
 * chosen for this person now, and a refetch mid-swipe would change the deck.
 */
export function useCalibrationCards() {
  const client = useSupabase();
  const household = useHousehold();
  const householdId = household.data?.id;
  const weekStart = comingWeekStart(new Date());

  return useQuery({
    queryKey: calibrationQueryKey(householdId, weekStart),
    enabled: householdId !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: () => {
      if (!householdId) throw new SuggestError("no_household");
      return suggestCalibration(client, { householdId, weekStart });
    },
  });
}
