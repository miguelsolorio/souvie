import type { ScheduledRun, ScheduleInput } from "@mp/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSupabase } from "../context";
import {
  createDefaultSchedule,
  createSchedule,
  deleteSchedule,
  fetchSchedule,
  fetchScheduleConnections,
  fetchSchedules,
  ScheduleApiError,
  type ScheduleConnection,
  scheduleConnectionsKey,
  scheduleKey,
  schedulesKey,
  updateSchedule,
} from "../schedules";
import { useHousehold } from "./useHousehold";

/**
 * The household's scheduled runs, soonest first. Members read them; only owners can change them
 * (`household.data.role`). Not persisted to the device: a schedule is small and the next run
 * moves each week.
 */
export function useSchedules() {
  const client = useSupabase();
  const household = useHousehold();
  const householdId = household.data?.id;
  return useQuery({
    queryKey: schedulesKey(householdId),
    enabled: Boolean(householdId),
    queryFn: (): Promise<ScheduledRun[]> =>
      householdId ? fetchSchedules(client, householdId) : Promise.resolve([]),
  });
}

/** One schedule, or null when it is not in the household. Idle without an id. */
export function useSchedule(scheduleId: string | null | undefined) {
  const client = useSupabase();
  const household = useHousehold();
  const householdId = household.data?.id;
  return useQuery({
    queryKey: scheduleKey(householdId, scheduleId),
    enabled: Boolean(householdId && scheduleId),
    queryFn: (): Promise<ScheduledRun | null> =>
      householdId && scheduleId
        ? fetchSchedule(client, householdId, scheduleId)
        : Promise.resolve(null),
  });
}

/** The store connections a schedule can pick from. Our own rows, read under RLS. */
export function useScheduleConnections() {
  const client = useSupabase();
  const household = useHousehold();
  const householdId = household.data?.id;
  return useQuery({
    queryKey: scheduleConnectionsKey(householdId),
    enabled: Boolean(householdId),
    queryFn: (): Promise<ScheduleConnection[]> =>
      householdId ? fetchScheduleConnections(client, householdId) : Promise.resolve([]),
  });
}

function useRefreshSchedules() {
  const queryClient = useQueryClient();
  const household = useHousehold();
  const householdId = household.data?.id;
  return () => queryClient.invalidateQueries({ queryKey: schedulesKey(householdId) });
}

/**
 * Creates a schedule (no `scheduleId`) or edits one. The caller sends what the person set; the
 * server works out `next_run_at`, and the saved schedule comes back with it.
 */
export function useSaveSchedule(scheduleId?: string | null) {
  const client = useSupabase();
  const household = useHousehold();
  const householdId = household.data?.id;
  const refresh = useRefreshSchedules();
  return useMutation<ScheduledRun, Error, ScheduleInput>({
    mutationFn: async (input) => {
      if (!householdId) throw new ScheduleApiError("not_owner");
      return scheduleId
        ? updateSchedule(client, householdId, scheduleId, input)
        : createSchedule(client, householdId, input);
    },
    onSuccess: () => refresh(),
  });
}

/** Switches a schedule on or off from the list. */
export function useToggleSchedule() {
  const client = useSupabase();
  const household = useHousehold();
  const householdId = household.data?.id;
  const refresh = useRefreshSchedules();
  return useMutation<ScheduledRun, Error, { scheduleId: string; enabled: boolean }>({
    mutationFn: async ({ scheduleId, enabled }) => {
      if (!householdId) throw new ScheduleApiError("not_owner");
      return updateSchedule(client, householdId, scheduleId, { enabled });
    },
    onSuccess: () => refresh(),
  });
}

export function useDeleteSchedule() {
  const client = useSupabase();
  const household = useHousehold();
  const householdId = household.data?.id;
  const refresh = useRefreshSchedules();
  return useMutation<void, Error, string>({
    mutationFn: async (scheduleId) => {
      if (!householdId) throw new ScheduleApiError("not_owner");
      await deleteSchedule(client, householdId, scheduleId);
    },
    onSuccess: () => refresh(),
  });
}

/** WS06's onboarding calls this when the person accepts "Saturday 9:00 for the week starting Monday". */
export function useCreateDefaultSchedule() {
  const client = useSupabase();
  const household = useHousehold();
  const householdId = household.data?.id;
  const refresh = useRefreshSchedules();
  return useMutation<ScheduledRun, Error, { timeZone?: string } | undefined>({
    mutationFn: async (options) => {
      if (!householdId) throw new ScheduleApiError("not_owner");
      return createDefaultSchedule(client, householdId, options?.timeZone);
    },
    onSuccess: () => refresh(),
  });
}
