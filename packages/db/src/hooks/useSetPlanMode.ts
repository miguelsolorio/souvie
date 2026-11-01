import type { PlanMode } from "@mp/core";
import {
  type MutationOptions,
  type QueryClient,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type { MpClient } from "../client";
import { useSupabase } from "../context";
import { setPlanMode } from "../identity";
import type { ActiveHousehold } from "./useHousehold";

export interface SetPlanModeInput {
  householdId: string;
  mode: PlanMode;
}

/** Every cached copy of the active household, whoever is signed in. */
const ACTIVE_HOUSEHOLD_KEY = ["household", "active"] as const;

/**
 * The cached household with its mode changed. Another household, or none, comes back untouched,
 * so a stale write for a household the person has since left cannot edit the one they are in.
 */
export function withPlanMode<T extends ActiveHousehold | null | undefined>(
  cached: T,
  householdId: string,
  mode: PlanMode,
): T {
  if (!cached || cached.id !== householdId || cached.plan_mode === mode) return cached;
  return { ...cached, plan_mode: mode };
}

/** What `patchActiveHouseholds` found, so a failed write can put it back. */
export type PreviousHouseholds = [readonly unknown[], ActiveHousehold | null | undefined][];

/** Shows the new mode in every cached copy of the household, and returns the copies as they were. */
export function patchActiveHouseholds(
  queryClient: QueryClient,
  { householdId, mode }: SetPlanModeInput,
): PreviousHouseholds {
  const previous = queryClient.getQueriesData<ActiveHousehold | null>({
    queryKey: ACTIVE_HOUSEHOLD_KEY,
  });
  queryClient.setQueriesData<ActiveHousehold | null>({ queryKey: ACTIVE_HOUSEHOLD_KEY }, (cached) =>
    withPlanMode(cached, householdId, mode),
  );
  return previous;
}

/** Puts the household copies `patchActiveHouseholds` returned back. */
export function restoreActiveHouseholds(
  queryClient: QueryClient,
  previous: PreviousHouseholds,
): void {
  for (const [key, data] of previous) queryClient.setQueryData(key, data);
}

interface SetPlanModeContext {
  /** The household copies as they were before the optimistic change. */
  previous: PreviousHouseholds;
}

/**
 * The mutation behind useSetPlanMode, as plain options so tests can run it without React.
 * The new mode shows at once in every cached copy of the household; if the server refuses (a
 * member or outsider updates zero rows and gets `not_owner`, or the write fails) the copies go
 * back to what they were; and once the write has settled either way, the household is marked
 * stale so the next read asks the server.
 */
export function setPlanModeOptions(
  client: MpClient,
  queryClient: QueryClient,
): MutationOptions<void, Error, SetPlanModeInput, SetPlanModeContext> {
  return {
    mutationFn: ({ householdId, mode }) => setPlanMode(client, householdId, mode),

    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: ACTIVE_HOUSEHOLD_KEY });
      return { previous: patchActiveHouseholds(queryClient, input) };
    },

    onError: (_error, _input, context) => {
      if (context) restoreActiveHouseholds(queryClient, context.previous);
    },

    onSettled: () => queryClient.invalidateQueries({ queryKey: ["household"] }),
  };
}

/**
 * Owner only: change how much the household plans (Just dinners or Every meal). The planner and
 * the settings screen switch at once; if the server refuses, the household goes back to what it
 * was. Used by household settings and by the first onboarding screen. Entries in hidden slots
 * are never touched. See setPlanModeOptions.
 */
export function useSetPlanMode() {
  const client = useSupabase();
  const queryClient = useQueryClient();
  return useMutation(setPlanModeOptions(client, queryClient));
}
