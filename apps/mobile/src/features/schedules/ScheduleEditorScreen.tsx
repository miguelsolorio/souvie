import { resolveTargetWeekStart } from "@mp/core";
import {
  toScheduleApiError,
  useDeleteSchedule,
  useHousehold,
  useNotificationSettings,
  useSaveSchedule,
  useSchedule,
  useScheduleConnections,
  useToggleSchedule,
} from "@mp/db";
import { SegmentedControl } from "@mp/ui/primitives";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Button } from "../../components/Button";
import { ErrorText, LoadingScreen, Screen, Section } from "../../components/Screen";
import { TextField } from "../../components/TextField";
import { confirmAction } from "../../lib/confirm";
import {
  connectionChoices,
  type DraftErrors,
  defaultConnectionId,
  describeSchedule,
  deviceTimeZone,
  draftOf,
  formatRun,
  NEW_SCHEDULE_ID,
  newDraft,
  previewNextRun,
  type ScheduleDraft,
  SUBSTITUTION_HELP,
  SUBSTITUTION_LABEL,
  toInput,
  WEEKDAYS,
  weekOfText,
  zoneLabel,
} from "./logic";
import { SCHEDULES_ROUTE } from "./routes";
import { TimeOfDayField } from "./TimeOfDayField";
import { ToggleRow } from "./ToggleRow";

/**
 * Creates or edits one schedule: the weekday and time, the store, the budget and swap rules, and an
 * on and off switch, with the next run worked out as you edit. The server decides when it really
 * runs; the preview is the same calculation (nextRunAt).
 *
 * `scheduleId` is "new" for a schedule that does not exist yet. Only an owner can save: a member
 * sees the schedule and why they cannot change it.
 */
export function ScheduleEditorScreen({ scheduleId }: { scheduleId: string }) {
  const router = useRouter();
  const isNew = scheduleId === NEW_SCHEDULE_ID;
  const household = useHousehold();
  const settings = useNotificationSettings();
  const stored = useSchedule(isNew ? null : scheduleId);
  const connections = useScheduleConnections();
  const save = useSaveSchedule(isNew ? null : scheduleId);
  const toggle = useToggleSchedule();
  const remove = useDeleteSchedule();

  // null means "show what the server has"; an object is an unsaved edit.
  const [edit, setEdit] = useState<ScheduleDraft | null>(null);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [failure, setFailure] = useState<string | null>(null);

  if (household.isPending || connections.isPending || (!isNew && stored.isPending)) {
    return <LoadingScreen label="Loading the schedule" />;
  }
  const isOwner = household.data?.role === "owner";
  const choices = connectionChoices(connections.data ?? []);

  let base: ScheduleDraft | null;
  if (isNew) {
    base = newDraft({
      tz: settings.data?.timezone ?? deviceTimeZone(),
      connectionId: defaultConnectionId(connections.data ?? []),
    });
  } else if (!stored.data) {
    return (
      <Screen title="Schedule">
        <Text className="text-base text-neutral-700">This schedule is not in your household.</Text>
        <Button label="Back to schedules" onPress={() => router.replace(SCHEDULES_ROUTE)} />
      </Screen>
    );
  } else {
    base = draftOf(stored.data);
  }

  // A schedule made outside the app with several weekdays: show it, let it be switched off or
  // deleted, but do not pretend the editor can change it.
  if (!base && stored.data) {
    const schedule = stored.data;
    return (
      <Screen title="Schedule" subtitle={describeSchedule(schedule.cron)}>
        <Text className="text-sm text-neutral-600">
          This schedule runs on more than one day, which the editor cannot show. You can switch it
          off or delete it.
        </Text>
        <ToggleRow
          testID="schedule-enabled"
          label="On"
          value={schedule.enabled}
          disabled={!isOwner || toggle.isPending}
          onChange={(enabled) => toggle.mutate({ scheduleId: schedule.id, enabled })}
        />
        {isOwner ? (
          <Button
            testID="schedule-delete"
            label="Delete schedule"
            variant="danger"
            loading={remove.isPending}
            onPress={() => void confirmDelete()}
          />
        ) : null}
      </Screen>
    );
  }
  if (!base) return <LoadingScreen />;

  const draft = edit ?? base;
  const readOnly = !isOwner;
  const next = previewNextRun(draft, new Date());

  function change(patch: Partial<ScheduleDraft>) {
    setEdit({ ...draft, ...patch });
    setFailure(null);
  }

  async function confirmDelete() {
    const ok = await confirmAction({
      title: "Delete schedule",
      message:
        "The shopper will stop shopping on this schedule. Runs already started are not affected.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    remove.mutate(scheduleId, {
      onSuccess: () => router.replace(SCHEDULES_ROUTE),
      onError: (cause) => setFailure(toScheduleApiError(cause).message),
    });
  }

  function submit() {
    const result = toInput(draft);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    save.mutate(result.input, {
      onSuccess: () => router.replace(SCHEDULES_ROUTE),
      onError: (cause) => setFailure(toScheduleApiError(cause).message),
    });
  }

  return (
    <Screen
      title={isNew ? "New schedule" : "Schedule"}
      subtitle="The shopper fills your store cart on its own at this time. You review the cart, then pick a pickup time and pay in the store's app."
    >
      {readOnly ? (
        <Text
          testID="schedule-readonly"
          className="rounded-xl bg-neutral-100 p-3 text-sm text-neutral-700"
        >
          Only the household owner can change shopping schedules.
        </Text>
      ) : null}

      <Section title="When">
        <View className="flex-row flex-wrap gap-2">
          {WEEKDAYS.map((day) => {
            const selected = day.value === draft.weekday;
            return (
              <Pressable
                key={day.value}
                testID={`schedule-weekday-${day.value}`}
                accessibilityRole="radio"
                accessibilityLabel={day.long}
                accessibilityState={{ selected, disabled: readOnly }}
                disabled={readOnly}
                onPress={() => change({ weekday: day.value })}
                className={`min-h-11 min-w-12 items-center justify-center rounded-xl border px-3 ${
                  selected ? "border-brand bg-brand" : "border-neutral-300 bg-white"
                } ${readOnly ? "opacity-60" : ""}`}
              >
                <Text
                  className={`text-base font-semibold ${selected ? "text-white" : "text-neutral-900"}`}
                >
                  {day.short}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <TimeOfDayField
          testID="schedule-time"
          label="Start at"
          hour={draft.hour}
          minute={draft.minute}
          disabled={readOnly}
          onChange={(hour, minute) => change({ hour, minute })}
        />
        <Text className="text-sm text-neutral-500">Times are in {zoneLabel(draft.tz)} time.</Text>
        <Text testID="schedule-next-run" className="text-base text-neutral-900">
          {draft.enabled
            ? next
              ? `Next run: ${formatRun(next, draft.tz)}`
              : "Next run: not set"
            : "This schedule is off, so it will not run."}
        </Text>
        {next ? (
          <Text testID="schedule-target-week" className="text-sm text-neutral-500">
            It shops the grocery list for the week of{" "}
            {weekOfText(resolveTargetWeekStart(next, draft.tz))}.
          </Text>
        ) : null}
      </Section>

      <Section title="Store">
        {choices.length === 0 ? (
          <Text testID="schedule-no-store" className="text-sm text-neutral-600">
            Connect a store in household settings first. A schedule needs one.
          </Text>
        ) : null}
        {choices.map((choice) => {
          const selected = choice.id === draft.connectionId;
          const blocked = choice.reason !== null;
          return (
            <Pressable
              key={choice.id}
              testID={`schedule-connection-${choice.id}`}
              accessibilityRole="radio"
              accessibilityLabel={choice.label}
              accessibilityState={{ selected, disabled: blocked || readOnly }}
              disabled={blocked || readOnly}
              onPress={() => change({ connectionId: choice.id })}
              className={`gap-0.5 rounded-xl border p-3 ${selected ? "border-brand bg-neutral-50" : "border-neutral-300 bg-white"} ${
                blocked ? "opacity-60" : ""
              }`}
            >
              <Text className="text-base font-medium text-neutral-900">{choice.label}</Text>
              {choice.reason ? (
                <Text className="text-sm text-neutral-500">{choice.reason}</Text>
              ) : null}
            </Pressable>
          );
        })}
        <ErrorText>{errors.connection}</ErrorText>
      </Section>

      <Section title="Rules">
        <TextField
          testID="schedule-budget"
          label="Budget cap (USD)"
          value={draft.budgetText}
          onChangeText={(budgetText) => change({ budgetText })}
          editable={!readOnly}
          keyboardType="decimal-pad"
          placeholder="No cap"
          helper="A cart over this amount waits for you instead of going on."
          error={errors.budget ?? null}
        />
        <SegmentedControl
          testID="schedule-substitution"
          label="When an item is out of stock"
          options={(["none", "same_brand", "any"] as const).map((value) => ({
            value,
            label: SUBSTITUTION_LABEL[value],
            testID: `schedule-substitution-${value}`,
          }))}
          value={draft.substitution}
          onChange={(substitution) => {
            if (!readOnly) change({ substitution });
          }}
        />
        <Text className="text-sm text-neutral-500">{SUBSTITUTION_HELP[draft.substitution]}</Text>
      </Section>

      <Section title="Status">
        <ToggleRow
          testID="schedule-enabled"
          label="On"
          description="Turn off to pause without losing the schedule."
          value={draft.enabled}
          disabled={readOnly}
          onChange={(enabled) => change({ enabled })}
        />
      </Section>

      <ErrorText>{failure ?? errors.tz}</ErrorText>

      {readOnly ? null : (
        <View className="gap-3">
          <Button
            testID="schedule-save"
            label={isNew ? "Add schedule" : "Save changes"}
            loading={save.isPending}
            disabled={choices.every((c) => c.reason !== null)}
            onPress={submit}
          />
          {isNew ? null : (
            <Button
              testID="schedule-delete"
              label="Delete schedule"
              variant="danger"
              loading={remove.isPending}
              onPress={() => void confirmDelete()}
            />
          )}
        </View>
      )}
    </Screen>
  );
}
