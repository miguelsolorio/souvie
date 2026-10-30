import { isIsoDate, isoDateOf, type MealSlot, shiftWeek, weekStartFor } from "@mp/core";
import { EmptyState } from "@mp/ui/primitives";
import { Redirect, Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../../src/components/Button";
import { LoadingScreen } from "../../../src/components/Screen";
import { CREATE_HOUSEHOLD_ROUTE } from "../../../src/features/auth/routes";
import { EntrySheet } from "../../../src/features/plan/EntrySheet";
import { PlanNoticeBar } from "../../../src/features/plan/PlanNotice";
import { dayRoute, MENU_ROUTE, pickRoute } from "../../../src/features/plan/routes";
import { usePlanActions } from "../../../src/features/plan/usePlanActions";
import { usePlanWeek } from "../../../src/features/plan/usePlanWeek";
import { WeekGrid } from "../../../src/features/plan/WeekGrid";
import { WeekHeader } from "../../../src/features/plan/WeekHeader";

/** `?week=` from the URL as a Monday, or this week's Monday when it is missing or not a date. */
function resolveWeek(raw: string | undefined, thisWeek: string): string {
  if (raw && isIsoDate(raw)) return weekStartFor(raw);
  return thisWeek;
}

/**
 * The planner's week view, and the app's home screen. Seven days, each with breakfast, lunch,
 * dinner, and snack slots; tap a slot to add a recipe, tap a meal to change it. Changes made by
 * another member of the household appear here on their own.
 */
export default function PlanScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ week?: string }>();
  const today = isoDateOf(new Date());
  const thisWeek = weekStartFor(today);
  const weekStart = resolveWeek(params.week, thisWeek);

  const data = usePlanWeek(weekStart);
  const actions = usePlanActions(data.householdId);
  const [openId, setOpenId] = useState<string | null>(null);
  const openEntry = useMemo(
    () => data.entries.find((entry) => entry.id === openId) ?? null,
    [data.entries, openId],
  );

  if (data.noHousehold) return <Redirect href={CREATE_HOUSEHOLD_ROUTE} />;
  if (data.loading) return <LoadingScreen label="Loading your week" />;

  const goToWeek = (week: string) => router.setParams({ week });
  const addTo = (date: string, slot: MealSlot) => router.push(pickRoute({ date, slot }));
  const isEmpty = data.entries.length === 0;

  return (
    <SafeAreaView className="flex-1 bg-white" edges={["bottom"]}>
      <Stack.Screen
        options={{
          title: "Plan",
          headerRight: () => (
            <Button
              label="Menu"
              variant="ghost"
              onPress={() => router.push(MENU_ROUTE)}
              testID="open-menu"
            />
          ),
        }}
      />
      <ScrollView
        testID="plan-scroll"
        contentContainerClassName="mx-auto w-full max-w-6xl gap-5 px-4 py-4"
        refreshControl={<RefreshControl refreshing={data.refreshing} onRefresh={data.refetch} />}
      >
        <WeekHeader
          weekStart={weekStart}
          isThisWeek={weekStart === thisWeek}
          onPrevious={() => goToWeek(shiftWeek(weekStart, -1))}
          onNext={() => goToWeek(shiftWeek(weekStart, 1))}
          onToday={() => goToWeek(thisWeek)}
          onGenerateList={(route) => router.push(route)}
        />

        <PlanNoticeBar />

        {data.offline ? (
          <Text testID="plan-offline" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
            You are offline and this week has not been saved on this device yet. Reconnect to load
            it.
          </Text>
        ) : null}

        {data.error ? (
          <View className="gap-3 rounded-xl border border-red-200 bg-red-50 p-4">
            <Text accessibilityRole="alert" className="text-base text-red-800">
              Could not load this week.
            </Text>
            <Button label="Try again" variant="secondary" onPress={data.refetch} />
          </View>
        ) : null}

        {isEmpty && !data.error ? (
          <EmptyState
            testID="plan-empty"
            icon="🍽"
            title="Nothing planned this week"
            message="Pick a day below and add a recipe. Your household sees every change as it happens."
            action={{
              label: "Plan a dinner",
              testID: "plan-first-dinner",
              onPress: () => addTo(firstOpenDay(weekStart, today), "dinner"),
            }}
          />
        ) : null}

        <WeekGrid
          weekStart={weekStart}
          byDay={data.byDay}
          today={today}
          onAdd={addTo}
          onOpenEntry={(entry) => setOpenId(entry.id)}
          onOpenDay={(date) => router.push(dayRoute(date))}
        />
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

/** Today when it falls in the week, else the week's Monday. */
function firstOpenDay(weekStart: string, today: string): string {
  return weekStartFor(today) === weekStart ? today : weekStart;
}
