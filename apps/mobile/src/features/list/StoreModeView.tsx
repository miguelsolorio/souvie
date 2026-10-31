import { sectionLabel } from "@mp/core";
import { useEditItem, useRemoveItem, useToggleItem, useUpdateList } from "@mp/db";
import { Redirect, Stack, useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../components/Button";
import { LoadingScreen } from "../../components/Screen";
import { CREATE_HOUSEHOLD_ROUTE } from "../auth/routes";
import { PlanNoticeBar } from "../plan/PlanNotice";
import { ItemRow } from "./ItemRow";
import { sectionsToShow, syncNote } from "./logic";
import { SectionGroup } from "./SectionGroup";
import { useListScreen } from "./useListScreen";
import { WhyThisAmountSheet } from "./WhyThisAmountSheet";

/**
 * In-store mode: the list with big rows, one section at a time in store order, built to be used
 * with one thumb in an aisle with no signal. Every check-off shows on the tap and is saved on the
 * device first (the replay queue), then sent when the connection allows; members who are shopping
 * the same list see each other's check-offs within a few seconds when they are online.
 */
export function StoreModeView({
  weekStart,
  listId,
}: {
  weekStart: string;
  listId?: string | null;
}) {
  const router = useRouter();
  const data = useListScreen({ weekStart, listId: listId ?? null });
  const list = data.list ?? null;
  const toggle = useToggleItem();
  const edit = useEditItem();
  const { remove } = useRemoveItem();
  const updateList = useUpdateList(list?.id);
  const [hideChecked, setHideChecked] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const openItem = useMemo(
    () => data.items.find((item) => item.id === openId) ?? null,
    [data.items, openId],
  );
  const groups = useMemo(
    () => sectionsToShow(data.split.toBuy, list?.section_order, { hideChecked }),
    [data.split.toBuy, list?.section_order, hideChecked],
  );

  if (data.noHousehold) return <Redirect href={CREATE_HOUSEHOLD_ROUTE} />;
  if (data.loading) return <LoadingScreen label="Loading your list" />;

  const note = syncNote(data.pending);
  const { done, total } = data.progress;
  const finished = total > 0 && done === total;

  return (
    <SafeAreaView className="flex-1 bg-white" edges={["bottom"]}>
      <Stack.Screen options={{ title: "Store mode" }} />
      <View className="border-b border-neutral-200 bg-white px-4 py-3">
        <View className="mx-auto w-full max-w-2xl gap-2">
          <View className="flex-row items-baseline justify-between gap-3">
            <Text testID="store-progress" className="text-2xl font-bold text-neutral-900">
              {done} of {total}
            </Text>
            <Pressable
              testID="store-hide-checked"
              accessibilityRole="switch"
              accessibilityState={{ checked: hideChecked }}
              accessibilityLabel="Hide items already checked off"
              onPress={() => setHideChecked((value) => !value)}
              className="min-h-11 justify-center rounded-xl border border-neutral-300 px-4"
            >
              <Text className="text-sm font-semibold text-neutral-900">
                {hideChecked ? "Show checked" : "Hide checked"}
              </Text>
            </Pressable>
          </View>
          <View
            accessibilityRole="progressbar"
            accessibilityValue={{ min: 0, max: total, now: done }}
            className="h-3 overflow-hidden rounded-full bg-neutral-200"
          >
            <View
              className="h-3 rounded-full bg-brand"
              style={{ width: `${Math.round(data.progress.fraction * 100)}%` }}
            />
          </View>
          {note ? (
            <Text
              testID="store-sync-note"
              accessibilityLiveRegion="polite"
              className="text-sm font-medium text-amber-800"
            >
              {note}
            </Text>
          ) : null}
        </View>
      </View>

      <ScrollView
        testID="store-scroll"
        contentContainerClassName="mx-auto w-full max-w-2xl gap-4 px-4 py-4"
        refreshControl={<RefreshControl refreshing={data.refreshing} onRefresh={data.refetch} />}
      >
        <PlanNoticeBar />

        {data.offline || (!list && !data.loading) ? (
          <Text
            testID="store-no-list"
            className="rounded-xl bg-amber-50 p-4 text-base text-amber-900"
          >
            {data.offline
              ? "You are offline and this list has not been saved on this device yet."
              : "There is no list for this week yet. Build it first."}
          </Text>
        ) : null}

        {list && total === 0 ? (
          <Text className="py-8 text-center text-lg text-neutral-600">
            Nothing to buy on this list.
          </Text>
        ) : null}

        {groups.map((group) => (
          <SectionGroup
            key={group.section}
            testID={`store-section-${group.section}`}
            title={sectionLabel(group.section)}
            count={group.items.length}
            large
          >
            {group.items.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                large
                onToggle={(row) => toggle(row)}
                onInfo={(row) => setOpenId(row.id)}
              />
            ))}
          </SectionGroup>
        ))}

        {list && hideChecked && groups.length === 0 && total > 0 ? (
          <Text className="py-8 text-center text-lg text-neutral-600">
            Everything is checked off.
          </Text>
        ) : null}

        {list ? (
          <View className="gap-3 pt-2">
            <Button
              testID="store-done"
              label={finished ? "Done shopping" : "Finish shopping"}
              variant={finished ? "primary" : "secondary"}
              loading={updateList.isPending}
              onPress={() =>
                updateList.mutate({ status: "shopped" }, { onSuccess: () => router.back() })
              }
            />
          </View>
        ) : null}
      </ScrollView>

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
