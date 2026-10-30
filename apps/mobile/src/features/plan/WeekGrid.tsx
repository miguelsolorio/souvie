import type { EntriesByDay } from "@mp/core";
import { MEAL_SLOTS, type MealSlot, weekDates } from "@mp/core";
import type { PlanEntry } from "@mp/db";
import { Pressable, Text, useWindowDimensions, View } from "react-native";
import { longDate, shortDayName, shortMonthDay } from "./format";
import { SlotCell } from "./SlotCell";

/** At this width and up the week is seven columns; below it, a list of days. */
export const WIDE_GRID_MIN_WIDTH = 900;

export function useIsWideGrid(): boolean {
  const { width } = useWindowDimensions();
  return width >= WIDE_GRID_MIN_WIDTH;
}

/**
 * The seven days of a week, each with a breakfast, lunch, dinner, and snack slot. On a phone it is
 * a list of day cards that open the day screen; on a wide window it is seven columns, so the whole
 * week is on screen at once.
 */
export function WeekGrid({
  weekStart,
  byDay,
  today,
  onAdd,
  onOpenEntry,
  onOpenDay,
}: {
  weekStart: string;
  byDay: EntriesByDay<PlanEntry>;
  /** The calendar date of today, to mark the current day. */
  today: string;
  onAdd: (date: string, slot: MealSlot) => void;
  onOpenEntry: (entry: PlanEntry) => void;
  onOpenDay: (date: string) => void;
}) {
  const wide = useIsWideGrid();
  const days = weekDates(weekStart);

  if (wide) {
    return (
      <View
        testID="week-grid"
        accessibilityLabel="Week plan, seven columns"
        className="flex-row gap-2"
      >
        {days.map((date) => (
          <View key={date} testID={`day-${date}`} className="min-w-0 flex-1 gap-2">
            <DayHeader date={date} today={today} onOpenDay={onOpenDay} centered />
            {MEAL_SLOTS.map((slot) => (
              <SlotCell
                key={slot}
                date={date}
                slot={slot}
                entries={byDay[date]?.[slot] ?? []}
                layout="cell"
                onAdd={() => onAdd(date, slot)}
                onOpen={onOpenEntry}
              />
            ))}
          </View>
        ))}
      </View>
    );
  }

  return (
    <View testID="week-grid" accessibilityLabel="Week plan, one card per day" className="gap-4">
      {days.map((date) => (
        <View
          key={date}
          testID={`day-${date}`}
          className={`gap-3 rounded-2xl border p-3 ${
            date === today ? "border-brand bg-green-50/40" : "border-neutral-200 bg-white"
          }`}
        >
          <DayHeader date={date} today={today} onOpenDay={onOpenDay} />
          {MEAL_SLOTS.map((slot) => (
            <SlotCell
              key={slot}
              date={date}
              slot={slot}
              entries={byDay[date]?.[slot] ?? []}
              layout="row"
              onAdd={() => onAdd(date, slot)}
              onOpen={onOpenEntry}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

function DayHeader({
  date,
  today,
  onOpenDay,
  centered = false,
}: {
  date: string;
  today: string;
  onOpenDay: (date: string) => void;
  centered?: boolean;
}) {
  const isToday = date === today;
  return (
    <Pressable
      testID={`open-day-${date}`}
      accessibilityRole="button"
      accessibilityLabel={`${longDate(date)}${isToday ? ", today" : ""}. Open the day`}
      onPress={() => onOpenDay(date)}
      className={`min-h-11 justify-center rounded-lg px-2 ${centered ? "items-center bg-neutral-100" : ""} ${
        isToday && centered ? "bg-brand" : ""
      }`}
    >
      {centered ? (
        <>
          <Text className={`text-xs font-semibold ${isToday ? "text-white" : "text-neutral-600"}`}>
            {shortDayName(date)}
          </Text>
          <Text className={`text-sm font-bold ${isToday ? "text-white" : "text-neutral-900"}`}>
            {shortMonthDay(date)}
          </Text>
        </>
      ) : (
        <View className="flex-row items-center justify-between">
          <Text className="text-base font-semibold text-neutral-900">{longDate(date)}</Text>
          {isToday ? (
            <Text className="rounded-full bg-brand px-2 py-0.5 text-xs font-semibold text-white">
              Today
            </Text>
          ) : null}
        </View>
      )}
    </Pressable>
  );
}
