import { sectionLabel, shiftWeek } from "@mp/core";
import {
  useAddManualItem,
  useEditItem,
  usePantry,
  useRemoveItem,
  useToggleItem,
  useUpdateList,
} from "@mp/db";
import { EmptyState } from "@mp/ui/primitives";
import { Redirect, Stack, useRouter } from "expo-router";
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../components/Button";
import { LoadingScreen } from "../../components/Screen";
import { CREATE_HOUSEHOLD_ROUTE } from "../auth/routes";
import { weekRangeLabel } from "../plan/format";
import { PlanNoticeBar } from "../plan/PlanNotice";
import { planRoute } from "../plan/routes";
import { AddItemBar } from "./AddItemBar";
import { ItemRow } from "./ItemRow";
import { sectionsToShow, syncNote } from "./logic";
import { OutOfDateBanner } from "./OutOfDateBanner";
import { PANTRY_ROUTE, storeModeRoute } from "./routes";
import { SectionGroup } from "./SectionGroup";
import { useListScreen } from "./useListScreen";
import { WhyThisAmountSheet } from "./WhyThisAmountSheet";

/**
 * The grocery list: the week's plan turned into one list, grouped by store section. Tap a row to
 * check it off, the info button for how its amount was worked out, and "Store mode" to shop with
 * big rows. Checks answer on the tap and sync in the background; another member's check-offs and
 * changes to the plan appear on their own.
 *
 * Open a week's list with `weekStart`, or a known list with `listId`.
 */
export function ListView({
  weekStart,
  listId,
  onWeekChange,
}: {
  weekStart: string;
  listId?: string | null;
  /** Called by the previous and next week buttons. Omit for a list opened by id (no week buttons). */
  onWeekChange?: (week: string) => void;
}) {
  const router = useRouter();
  const data = useListScreen({ weekStart, listId: listId ?? null });
  const list = data.list ?? null;

  const toggle = useToggleItem();
  const edit = useEditItem();
  const { remove, restore } = useRemoveItem();
  const add = useAddManualItem(list?.id);
  const pantry = usePantry();
  const updateList = useUpdateList(list?.id);

  const [openId, setOpenId] = useState<string | null>(null);
  const openItem = useMemo(
    () => data.items.find((item) => item.id === openId) ?? null,
    [data.items, openId],
  );
  const groups = useMemo(
    () => sectionsToShow(data.split.toBuy, list?.section_order),
    [data.split.toBuy, list?.section_order],
  );

  if (data.noHousehold) return <Redirect href={CREATE_HOUSEHOLD_ROUTE} />;
  if (data.loading) return <LoadingScreen label="Loading your list" />;

  const shopped = list?.status === "shopped";
  const note = syncNote(data.pending);
  const weekLabel = data.weekStart ? weekRangeLabel(data.weekStart) : "Groceries";

  return (
    <SafeAreaView className="flex-1 bg-white" edges={["bottom"]}>
      <Stack.Screen
        options={{
          title: "Groceries",
          headerRight: list
            ? () => (
                <Button
                  testID="open-store-mode"
                  label="Store mode"
                  variant="ghost"
                  onPress={() => router.push(storeModeRoute(list.id))}
                />
              )
            : undefined,
        }}
      />
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          testID="list-scroll"
          keyboardShouldPersistTaps="handled"
          contentContainerClassName="mx-auto w-full max-w-2xl gap-5 px-4 py-4"
          refreshControl={<RefreshControl refreshing={data.refreshing} onRefresh={data.refetch} />}
        >
          {onWeekChange && data.weekStart ? (
            <View className="flex-row items-center justify-between gap-2">
              <WeekButton
                testID="list-week-previous"
                label="Previous week"
                glyph="‹"
                onPress={() => onWeekChange(shiftWeek(weekStart, -1))}
              />
              <Text
                accessibilityRole="header"
                testID="list-week-label"
                className="flex-1 text-center text-lg font-bold text-neutral-900"
              >
                {weekLabel}
              </Text>
              <WeekButton
                testID="list-week-next"
                label="Next week"
                glyph="›"
                onPress={() => onWeekChange(shiftWeek(weekStart, 1))}
              />
            </View>
          ) : null}

          <PlanNoticeBar />

          {data.offline ? (
            <Text
              testID="list-offline"
              className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900"
            >
              You are offline and this list has not been saved on this device yet. Open it once with
              a connection and it will work in the store.
            </Text>
          ) : null}

          {data.staleCopy ? (
            <Text
              testID="list-stale-copy"
              className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900"
            >
              Showing the copy saved on this device. Could not refresh just now.
            </Text>
          ) : null}

          {data.error ? (
            <View className="gap-3 rounded-xl border border-red-200 bg-red-50 p-4">
              <Text accessibilityRole="alert" className="text-base text-red-800">
                Could not load your list.
              </Text>
              <Button label="Try again" variant="secondary" onPress={data.refetch} />
            </View>
          ) : null}

          {!list && !data.error && !data.offline ? (
            data.mealCount === 0 ? (
              <EmptyState
                testID="list-no-plan"
                icon="🛒"
                title="Nothing planned this week"
                message="Plan a few meals and your grocery list builds itself from them."
                action={{
                  label: "Open the planner",
                  testID: "list-open-planner",
                  onPress: () => router.push(planRoute(weekStart)),
                }}
              />
            ) : (
              <View testID="list-not-built" className="items-center gap-4 py-10">
                <Text className="text-5xl">🛒</Text>
                <Text
                  accessibilityRole="header"
                  className="text-center text-xl font-bold text-neutral-900"
                >
                  {data.mealCount === 1 ? "1 meal planned" : `${data.mealCount} meals planned`}
                </Text>
                <Text className="max-w-sm text-center text-base text-neutral-600">
                  Build the list to add up every recipe, take out what you already have, and sort it
                  by store section.
                </Text>
                {data.build.error ? (
                  <Text accessibilityRole="alert" className="text-sm text-red-700">
                    {data.build.error}
                  </Text>
                ) : null}
                <View className="w-full max-w-xs">
                  <Button
                    testID="list-build"
                    label="Build grocery list"
                    loading={data.build.building}
                    onPress={data.build.run}
                  />
                </View>
              </View>
            )
          ) : null}

          {list ? (
            <>
              {data.stale ? (
                <OutOfDateBanner
                  onRebuild={data.build.run}
                  rebuilding={data.build.building}
                  error={data.build.error}
                />
              ) : null}

              <View className="gap-3">
                <View className="flex-row items-baseline justify-between gap-3">
                  <Text testID="list-name" className="flex-1 text-lg font-bold text-neutral-900">
                    {list.name}
                  </Text>
                  <Text testID="list-progress" className="text-sm font-medium text-neutral-600">
                    {data.progress.done} of {data.progress.total} done
                  </Text>
                </View>
                <View
                  accessibilityRole="progressbar"
                  accessibilityValue={{ min: 0, max: data.progress.total, now: data.progress.done }}
                  className="h-2 overflow-hidden rounded-full bg-neutral-200"
                >
                  <View
                    className="h-2 rounded-full bg-brand"
                    style={{ width: `${Math.round(data.progress.fraction * 100)}%` }}
                  />
                </View>
                {note ? (
                  <Text
                    testID="list-sync-note"
                    accessibilityLiveRegion="polite"
                    className="text-xs text-neutral-500"
                  >
                    {note}
                  </Text>
                ) : null}
                {shopped ? (
                  <Text className="rounded-xl bg-neutral-100 p-3 text-sm text-neutral-700">
                    You marked this list as shopped.
                  </Text>
                ) : null}
              </View>

              {data.split.toBuy.length === 0 ? (
                <Text testID="list-empty" className="py-6 text-center text-base text-neutral-600">
                  Nothing to buy. Add an item below if you need something.
                </Text>
              ) : null}

              {groups.map((group) => (
                <SectionGroup
                  key={group.section}
                  testID={`section-${group.section}`}
                  title={sectionLabel(group.section)}
                  count={group.items.length}
                >
                  {group.items.map((item) => (
                    <ItemRow
                      key={item.id}
                      item={item}
                      onToggle={(row) => toggle(row)}
                      onInfo={(row) => setOpenId(row.id)}
                    />
                  ))}
                </SectionGroup>
              ))}

              {data.split.haveAlready.length > 0 ? (
                <SectionGroup
                  testID="section-already-have"
                  title="Already have"
                  count={data.split.haveAlready.length}
                  collapsible
                  defaultCollapsed
                >
                  {data.split.haveAlready.map((item) => (
                    <ItemRow
                      key={item.id}
                      item={item}
                      mode="have"
                      onAction={(row) => {
                        // Out of it after all: say so in the pantry, so the next build keeps it
                        // on the list, and put it on this one now.
                        if (row.ingredient_id) {
                          pantry.setStatus({ ingredientId: row.ingredient_id, status: "out" });
                        }
                        restore(row.id);
                      }}
                    />
                  ))}
                </SectionGroup>
              ) : null}

              {data.split.removed.length > 0 ? (
                <SectionGroup
                  testID="section-removed"
                  title="Removed"
                  count={data.split.removed.length}
                  collapsible
                  defaultCollapsed
                >
                  {data.split.removed.map((item) => (
                    <ItemRow
                      key={item.id}
                      item={item}
                      mode="removed"
                      onAction={(row) => restore(row.id)}
                    />
                  ))}
                </SectionGroup>
              ) : null}

              <View className="gap-3 pt-2">
                {data.stale ? null : (
                  <Button
                    testID="list-rebuild-anyway"
                    label="Rebuild from the plan"
                    variant="secondary"
                    loading={data.build.building}
                    onPress={data.build.run}
                  />
                )}
                <Button
                  testID="list-pantry"
                  label="Pantry"
                  variant="secondary"
                  onPress={() => router.push(PANTRY_ROUTE)}
                />
                <Button
                  testID="list-mark-shopped"
                  label={shopped ? "Reopen list" : "Mark as shopped"}
                  variant="ghost"
                  loading={updateList.isPending}
                  onPress={() => updateList.mutate({ status: shopped ? "active" : "shopped" })}
                />
              </View>
            </>
          ) : null}

          {data.refreshing && !list ? <ActivityIndicator color="#2F6B4F" /> : null}
        </ScrollView>

        {list ? (
          <View className="border-t border-neutral-200 bg-white px-4 py-3">
            <View className="mx-auto w-full max-w-2xl">
              <AddItemBar onAdd={(name) => add({ display_name: name })} />
            </View>
          </View>
        ) : null}
      </KeyboardAvoidingView>

      <WhyThisAmountSheet
        item={openItem}
        sectionOrder={list?.section_order}
        onClose={() => setOpenId(null)}
        onSave={(itemId, patch) => edit(itemId, patch)}
        onRemove={(item) => remove(item)}
      />
    </SafeAreaView>
  );
}

function WeekButton({
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
