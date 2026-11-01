import {
  toScheduleApiError,
  useHousehold,
  useNotificationPreferences,
  useNotificationSettings,
  useSaveQuietHours,
  useSetNotificationPreference,
} from "@mp/db";
import { useState } from "react";
import { Text, View } from "react-native";
import { Button } from "../../components/Button";
import { ErrorText, LoadingScreen, Screen, Section } from "../../components/Screen";
import { deviceTimeZone, zoneLabel } from "../schedules/logic";
import { TimeOfDayField } from "../schedules/TimeOfDayField";
import { ToggleRow } from "../schedules/ToggleRow";
import { NOTIFICATION_ROWS, type QuietDraft, quietDraftOf, sameQuiet, toQuietHours } from "./logic";

/**
 * Which pushes you get, and the household's quiet hours. The switches are yours alone; quiet hours
 * belong to the household (a push due inside them waits for their end), so only the owner changes
 * them and everyone sees them.
 */
export function NotificationsScreen() {
  const household = useHousehold();
  const prefs = useNotificationPreferences();
  const settings = useNotificationSettings();
  const setPreference = useSetNotificationPreference();
  const saveQuiet = useSaveQuietHours();

  // null means "show what the server has"; an object is an unsaved edit.
  const [edit, setEdit] = useState<QuietDraft | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (household.isPending || prefs.isPending || settings.isPending) {
    return <LoadingScreen label="Loading notification settings" />;
  }
  if (prefs.isError || settings.isError) {
    return (
      <Screen title="Notifications">
        <Text accessibilityRole="alert" className="text-base text-red-700">
          Could not load your notification settings.
        </Text>
        <Button
          label="Try again"
          onPress={() => {
            void prefs.refetch();
            void settings.refetch();
          }}
        />
      </Screen>
    );
  }

  const isOwner = household.data?.role === "owner";
  const stored = quietDraftOf(settings.data?.quietHours ?? null);
  const draft = edit ?? stored;
  const dirty = edit !== null && !sameQuiet(edit, stored);
  const zone = settings.data?.timezone ?? deviceTimeZone() ?? "America/Los_Angeles";

  function change(patch: Partial<QuietDraft>) {
    setEdit({ ...draft, ...patch });
    setFailure(null);
    setSaved(false);
  }

  function submit() {
    const result = toQuietHours(draft);
    if (!result.ok) {
      setFailure(result.error);
      return;
    }
    saveQuiet.mutate(
      {
        quietHours: result.quietHours,
        // The first time quiet hours are saved, the household's zone is this phone's.
        ...(settings.data?.timezone ? {} : { timezone: zone }),
      },
      {
        onSuccess: () => {
          setEdit(null);
          setSaved(true);
        },
        onError: (cause) => setFailure(toScheduleApiError(cause).message),
      },
    );
  }

  return (
    <Screen
      title="Notifications"
      subtitle="Pushes never name what is in your cart. They say the store and the total."
    >
      <Section title="Tell me when">
        {NOTIFICATION_ROWS.map((row) => (
          <ToggleRow
            key={row.type}
            testID={`notification-${row.type}`}
            label={row.label}
            description={row.help}
            value={prefs.data?.[row.type] ?? true}
            onChange={(enabled) => setPreference.mutate({ type: row.type, enabled })}
          />
        ))}
        {setPreference.isError ? (
          <ErrorText>{toScheduleApiError(setPreference.error).message}</ErrorText>
        ) : null}
      </Section>

      <Section title="Quiet hours">
        <Text className="text-sm text-neutral-600">
          A push that comes up inside quiet hours waits until they end. A cart that needs your
          review still waits for you: it is sent first thing, marked urgent.
        </Text>
        <ToggleRow
          testID="quiet-enabled"
          label="Hold pushes overnight"
          value={draft.enabled}
          disabled={!isOwner}
          onChange={(enabled) => change({ enabled })}
        />
        {draft.enabled ? (
          <View className="gap-4">
            <TimeOfDayField
              testID="quiet-start"
              label="From"
              hour={draft.startHour}
              minute={draft.startMinute}
              disabled={!isOwner}
              onChange={(startHour, startMinute) => change({ startHour, startMinute })}
            />
            <TimeOfDayField
              testID="quiet-end"
              label="Until"
              hour={draft.endHour}
              minute={draft.endMinute}
              disabled={!isOwner}
              onChange={(endHour, endMinute) => change({ endHour, endMinute })}
            />
            <Text className="text-sm text-neutral-500">Times are in {zoneLabel(zone)} time.</Text>
          </View>
        ) : null}
        {isOwner ? (
          <Button
            testID="quiet-save"
            label="Save quiet hours"
            loading={saveQuiet.isPending}
            disabled={!dirty}
            onPress={submit}
          />
        ) : (
          <Text testID="quiet-members-note" className="text-sm text-neutral-500">
            Only the household owner can change quiet hours.
          </Text>
        )}
        {saved ? (
          <Text testID="quiet-saved" className="text-sm text-neutral-600">
            Saved.
          </Text>
        ) : null}
        <ErrorText>{failure}</ErrorText>
      </Section>
    </Screen>
  );
}
