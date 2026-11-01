import {
  toScheduleApiError,
  useCreateDefaultSchedule,
  useHousehold,
  useScheduleConnections,
  useSchedules,
  useToggleSchedule,
} from "@mp/db";
import { EmptyState } from "@mp/ui/primitives";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Button } from "../../components/Button";
import { ErrorText, LoadingScreen, Screen } from "../../components/Screen";
import { describeSchedule, deviceTimeZone, formatRun, zoneLabel } from "./logic";
import { NEW_SCHEDULE_ROUTE, scheduleRoute } from "./routes";
import { ToggleRow } from "./ToggleRow";

/**
 * The household's shopping schedules: when each one runs next, at which store, and an on and off
 * switch. Anyone in the household can look; only the owner can add, change or switch one.
 */
export function ScheduleListScreen() {
  const router = useRouter();
  const household = useHousehold();
  const schedules = useSchedules();
  const connections = useScheduleConnections();
  const toggle = useToggleSchedule();
  const createDefault = useCreateDefaultSchedule();
  const [failure, setFailure] = useState<string | null>(null);

  if (household.isPending || schedules.isPending)
    return <LoadingScreen label="Loading schedules" />;
  const isOwner = household.data?.role === "owner";

  if (schedules.isError) {
    return (
      <Screen title="Shopping schedules">
        <Text accessibilityRole="alert" className="text-base text-red-700">
          Could not load the schedules.
        </Text>
        <Button label="Try again" onPress={() => void schedules.refetch()} />
      </Screen>
    );
  }

  const rows = schedules.data ?? [];
  const storeOf = (connectionId: string) =>
    connections.data?.find((c) => c.id === connectionId)?.storeName ?? "Your store";

  function addSuggested() {
    setFailure(null);
    const timeZone = deviceTimeZone();
    createDefault.mutate(timeZone ? { timeZone } : undefined, {
      onError: (cause) => setFailure(toScheduleApiError(cause).message),
    });
  }

  return (
    <Screen
      title="Shopping schedules"
      subtitle="Set it once and the shopper fills your store cart for you. It stops at a full cart: you review it, then pick a pickup time and pay in the store's app."
    >
      {rows.length === 0 ? (
        <EmptyState
          testID="schedules-empty"
          title="Nothing scheduled"
          message={
            isOwner
              ? "Shop for next week every Saturday at 9:00 AM, or pick your own day."
              : "The household owner can set up a weekly run."
          }
          {...(isOwner
            ? {
                action: {
                  label: "Add Saturday at 9:00 AM",
                  testID: "schedule-add-suggested",
                  onPress: addSuggested,
                },
              }
            : {})}
        />
      ) : (
        <View className="gap-3">
          {rows.map((schedule) => (
            <View
              key={schedule.id}
              testID={`schedule-${schedule.id}`}
              className="gap-1 rounded-xl border border-neutral-200 bg-white p-4"
            >
              <Pressable
                testID={`schedule-open-${schedule.id}`}
                accessibilityRole="button"
                accessibilityLabel={`${describeSchedule(schedule.cron)}, ${storeOf(schedule.connection_id)}`}
                onPress={() => router.push(scheduleRoute(schedule.id))}
                className="gap-0.5"
              >
                <Text className="text-lg font-semibold text-neutral-900">
                  {describeSchedule(schedule.cron)}
                </Text>
                <Text className="text-sm text-neutral-600">{storeOf(schedule.connection_id)}</Text>
                <Text testID={`schedule-next-${schedule.id}`} className="text-sm text-neutral-500">
                  {schedule.enabled
                    ? `Next run: ${formatRun(new Date(schedule.next_run_at), schedule.tz)} (${zoneLabel(schedule.tz)} time)`
                    : "Off"}
                </Text>
              </Pressable>
              <ToggleRow
                testID={`schedule-toggle-${schedule.id}`}
                label={schedule.enabled ? "On" : "Off"}
                value={schedule.enabled}
                disabled={!isOwner || toggle.isPending}
                onChange={(enabled) => {
                  setFailure(null);
                  toggle.mutate(
                    { scheduleId: schedule.id, enabled },
                    { onError: (cause) => setFailure(toScheduleApiError(cause).message) },
                  );
                }}
              />
            </View>
          ))}
        </View>
      )}

      <ErrorText>{failure}</ErrorText>

      {isOwner ? (
        <Button
          testID="schedule-add"
          label="Add a schedule"
          variant={rows.length === 0 ? "secondary" : "primary"}
          onPress={() => router.push(NEW_SCHEDULE_ROUTE)}
        />
      ) : (
        <Text testID="schedules-members-note" className="text-sm text-neutral-500">
          Only the household owner can change shopping schedules.
        </Text>
      )}
    </Screen>
  );
}
