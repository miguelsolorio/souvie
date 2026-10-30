import { Pressable, Text, View } from "react-native";
import { Button } from "../../components/Button";
import { weekRangeLabel } from "./format";
import { SyncStatus } from "./PlanNotice";
import { GROCERY_LIST_PENDING_HINT, GROCERY_LIST_ROUTE } from "./routes";

/**
 * The week view's controls: previous and next week, a way back to this week, the "Generate list"
 * button, and the saving indicator.
 */
export function WeekHeader({
  weekStart,
  isThisWeek,
  onPrevious,
  onNext,
  onToday,
  onGenerateList,
}: {
  weekStart: string;
  isThisWeek: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onToday: () => void;
  onGenerateList: (route: string) => void;
}) {
  const listReady = GROCERY_LIST_ROUTE !== null;

  return (
    <View className="gap-3">
      <View className="flex-row items-center justify-between gap-2">
        <NavButton testID="week-previous" label="Previous week" glyph="‹" onPress={onPrevious} />
        <View className="flex-1 items-center">
          <Text
            accessibilityRole="header"
            testID="week-label"
            className="text-lg font-bold text-neutral-900"
          >
            {weekRangeLabel(weekStart)}
          </Text>
          <Text className="text-xs text-neutral-500">
            {isThisWeek ? "This week" : `Week of ${weekStart}`}
          </Text>
        </View>
        <NavButton testID="week-next" label="Next week" glyph="›" onPress={onNext} />
      </View>

      <View className="flex-row flex-wrap items-center justify-between gap-3">
        <View className="flex-row items-center gap-3">
          {isThisWeek ? null : (
            <Pressable
              testID="week-today"
              accessibilityRole="button"
              accessibilityLabel="Jump to this week"
              onPress={onToday}
              className="min-h-11 justify-center rounded-xl border border-neutral-300 bg-white px-4"
            >
              <Text className="text-sm font-semibold text-neutral-900">This week</Text>
            </Pressable>
          )}
          <SyncStatus />
        </View>
        <View className="items-end gap-1">
          <View className="min-w-40">
            <Button
              testID="generate-list"
              label="Generate list"
              variant="secondary"
              disabled={!listReady}
              onPress={() => {
                if (GROCERY_LIST_ROUTE) onGenerateList(GROCERY_LIST_ROUTE);
              }}
            />
          </View>
          {listReady ? null : (
            <Text
              testID="generate-list-hint"
              className="max-w-56 text-right text-xs text-neutral-500"
            >
              {GROCERY_LIST_PENDING_HINT}
            </Text>
          )}
        </View>
      </View>
    </View>
  );
}

function NavButton({
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
