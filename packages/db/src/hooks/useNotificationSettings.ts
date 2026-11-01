import type { NotificationType, QuietHours } from "@mp/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSupabase } from "../context";
import {
  fetchNotificationPreferences,
  fetchNotificationSettings,
  type NotificationPreferences,
  type NotificationSettings,
  notificationPreferencesKey,
  notificationSettingsKey,
  saveNotificationSettings,
  setNotificationPreference,
} from "../schedules";
import { useHousehold } from "./useHousehold";
import { useSession } from "./useSession";

/** The household's quiet hours and zone. Everyone reads them; owners change them. */
export function useNotificationSettings() {
  const client = useSupabase();
  const household = useHousehold();
  const householdId = household.data?.id;
  return useQuery({
    queryKey: notificationSettingsKey(householdId),
    enabled: Boolean(householdId),
    queryFn: (): Promise<NotificationSettings> =>
      householdId
        ? fetchNotificationSettings(client, householdId)
        : Promise.resolve({ timezone: null, quietHours: null }),
  });
}

/** Sets or clears quiet hours. The zone is saved with them so the times mean the same everywhere. */
export function useSaveQuietHours() {
  const client = useSupabase();
  const queryClient = useQueryClient();
  const household = useHousehold();
  const householdId = household.data?.id;
  return useMutation<void, Error, { quietHours: QuietHours | null; timezone?: string }>({
    mutationFn: async (settings) => {
      if (!householdId) throw new Error("no household");
      await saveNotificationSettings(client, householdId, settings);
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: notificationSettingsKey(householdId) }),
  });
}

/** The signed-in person's own choices, every type present (a type they never changed is on). */
export function useNotificationPreferences() {
  const client = useSupabase();
  const { user } = useSession();
  const userId = user?.id;
  return useQuery({
    queryKey: notificationPreferencesKey(userId),
    enabled: Boolean(userId),
    queryFn: (): Promise<NotificationPreferences | null> =>
      userId ? fetchNotificationPreferences(client, userId) : Promise.resolve(null),
  });
}

/** Turns one type on or off for this person, showing the change at once and undoing it on failure. */
export function useSetNotificationPreference() {
  const client = useSupabase();
  const queryClient = useQueryClient();
  const { user } = useSession();
  const userId = user?.id;
  const key = notificationPreferencesKey(userId);
  return useMutation<
    void,
    Error,
    { type: NotificationType; enabled: boolean },
    { previous: NotificationPreferences | null | undefined }
  >({
    mutationFn: ({ type, enabled }) => setNotificationPreference(client, type, enabled),
    onMutate: async ({ type, enabled }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<NotificationPreferences | null>(key);
      if (previous)
        queryClient.setQueryData<NotificationPreferences>(key, { ...previous, [type]: enabled });
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
}
