import { isIsoDate, isoDateOf, MEAL_SLOTS, weekStartFor } from "@mp/core";
import { Redirect, Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../../src/components/Button";
import { LoadingScreen } from "../../../src/components/Screen";
import { CREATE_HOUSEHOLD_ROUTE } from "../../../src/features/auth/routes";
import { EntryCard } from "../../../src/features/plan/EntryCard";
import { EntrySheet } from "../../../src/features/plan/EntrySheet";
import { longDate, neighborDay, SLOT_LABELS } from "../../../src/features/plan/format";
import { PlanNoticeBar, SyncStatus } from "../../../src/features/plan/PlanNotice";
import { pickRoute, planRoute } from "../../../src/features/plan/routes";
import { usePlanActions } from "../../../src/features/plan/usePlanActions";
import { usePlanWeek } from "../../../src/features/plan/usePlanWeek";

/**
 * One day of the plan, larger than the week view's cell: every slot with its meals as cards. The
 * arrows step to the day before and after, across week boundaries.
 */
export default function DayScreen() {
  const router = useRouter();
  const { date } = useLocalSearchParams<{ date: string }>();
  const valid = typeof date === "string" && isIsoDate(date);
  const day = valid ? date : isoDateOf(new Date());
  const weekStart = weekStartFor(day);

  const data = usePlanWeek(weekStart);
  const actions = usePlanActions(data.householdId);
  const [openId, setOpenId] = useState<string | null>(null);
  const openEntry = useMemo(
    () => data.entries.find((entry) => entry.id === openId) ?? null,
    [data.entries, openId],
  );

  if (!valid) return <Redirect href={planRoute()} />;
  if (data.noHousehold) return <Redirect href={CREATE_HOUSEHOLD_ROUTE} />;
  if (data.loading) return <LoadingScreen label="Loading the day" />;

  const today = isoDateOf(new Date());
  const step = (direction: 1 | -1) => router.setParams({ date: neighborDay(day, direction) });

  return (
    <SafeAreaView className="flex-1 bg-white" edges={["bottom"]}>
      <Stack.Screen options={{ title: day === today ? "Today" : longDate(day) }} />
      <ScrollView
        contentContainerClassName="mx-auto w-full max-w-2xl gap-6 px-4 py-4"
        refreshControl={<RefreshControl refreshing={data.refreshing} onRefresh={data.refetch} />}
      >
        <View className="flex-row items-center justify-between gap-2">
          <DayArrow testID="day-previous" label="Previous day" glyph="‹" onPress={() => step(-1)} />
          <View className="flex-1 items-center">
            <Text
              accessibilityRole="header"
              testID="day-label"
              className="text-xl font-bold text-neutral-900"
            >
              {longDate(day)}
            </Text>
            <SyncStatus />
          </View>
          <DayArrow testID="day-next" label="Next day" glyph="›" onPress={() => step(1)} />
        </View>

        <PlanNoticeBar />

        {data.error ? (
          <View className="gap-3 rounded-xl border border-red-200 bg-red-50 p-4">
            <Text accessibilityRole="alert" className="text-base text-red-800">
              Could not load this day.
            </Text>
            <Button label="Try again" variant="secondary" onPress={data.refetch} />
          </View>
        ) : null}

        {MEAL_SLOTS.map((slot) => {
          const entries = data.byDay[day]?.[slot] ?? [];
          return (
            <View key={slot} testID={`day-slot-${slot}`} className="gap-3">
              <Text accessibilityRole="header" className="text-lg font-semibold text-neutral-900">
                {SLOT_LABELS[slot]}
              </Text>
              {entries.map((entry) => (
                <EntryCard key={entry.id} entry={entry} onOpen={(e) => setOpenId(e.id)} />
              ))}
              <Button
                testID={`add-${day}-${slot}`}
                label={
                  entries.length > 0
                    ? "Add another recipe"
                    : `Add ${SLOT_LABELS[slot].toLowerCase()}`
                }
                variant="secondary"
                onPress={() => router.push(pickRoute({ date: day, slot }))}
              />
            </View>
          );
        })}

        <Pressable
          testID="back-to-week"
          accessibilityRole="link"
          onPress={() => router.replace(planRoute(weekStart))}
          className="min-h-11 items-center justify-center"
        >
          <Text className="text-base font-medium text-brand underline">Back to the week</Text>
        </Pressable>
      </ScrollView>

      <EntrySheet
        entry={openEntry}
        weekEntries={data.entries}
        actions={actions}
        onClose={() => setOpenId(null)}
      />
    </SafeAreaView>
  );
}

function DayArrow({
  testID,
  label,
  glyph,
  onPress,
}: {
  testID: string;
  label: string;
  glyph: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className="h-12 w-12 items-center justify-center rounded-xl border border-neutral-300 bg-white"
    >
      <Text className="text-2xl font-semibold text-neutral-900">{glyph}</Text>
    </Pressable>
  );
}
