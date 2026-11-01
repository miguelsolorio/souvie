import type { EntriesByDay, PlanMode } from "@mp/core";
import { type MealSlot, slotsForMode, weekDates } from "@mp/core";
import type { PlanEntry } from "@mp/db";
import { useRef } from "react";
import { Pressable, Text, View } from "react-native";
import { useIsDesktop } from "../../lib/useBreakpoint";
import { WebSpace } from "../../lib/webSpace";
import { longDate, SLOT_LABELS, shortDayName, shortMonthDay } from "./format";
import { GridDesktopInput } from "./GridDesktopInput";
import { moreMealsOf } from "./mode";
import { EntryChip, MoreMeals, SlotCell } from "./SlotCell";

/** At the desktop breakpoint (1024 and up) the week is seven columns; below it, a list of days. */
export function useIsWideGrid(): boolean {
  return useIsDesktop();
}

/**
 * The seven days of a week. In Every meal mode each day has a breakfast, lunch, dinner, and snack
 * slot; in Just dinners mode it has the dinner slot only, and any meal planned in another slot
 * waits under a collapsed "More meals" row for its day (never hidden for good, and still on the
 * grocery list). On a phone it is a list of day cards that open the day screen; on a wide window
 * it is seven columns, so the whole week is on screen at once.
 */
export function WeekGrid({
  weekStart,
  mode,
  byDay,
  today,
  onAdd,
  onOpenEntry,
  onOpenDay,
  onTodayOffset,
}: {
  weekStart: string;
  /** How much the household plans: decides which slots get a cell. */
  mode: PlanMode;
  byDay: EntriesByDay<PlanEntry>;
  /** The calendar date of today, to mark the current day. */
  today: string;
  onAdd: (date: string, slot: MealSlot) => void;
  onOpenEntry: (entry: PlanEntry) => void;
  onOpenDay: (date: string) => void;
  /**
   * On a phone the week is a long list. Called with today's card's distance from the top of the
   * scrolling content, once it has been laid out, so the screen can open on today.
   */
  onTodayOffset?: (y: number) => void;
}) {
  const wide = useIsWideGrid();
  const days = weekDates(weekStart);
  const gridY = useRef(0);
  const slots = slotsForMode(mode);
  const moreByDay = Object.fromEntries(days.map((date) => [date, moreMealsOf(byDay[date], mode)]));
  const anyMore = days.some((date) => (moreByDay[date]?.length ?? 0) > 0);

  if (wide) {
    return (
      // One row per slot, seven cells across, so breakfast, lunch, dinner and snack line up from
      // day to day and a tall cell stretches its neighbors.
      <View testID="week-grid" accessibilityLabel="Week plan, seven columns" className="gap-2">
        {/* WS13: drag a meal to another slot, and arrow keys between days (web only). */}
        <GridDesktopInput byDay={byDay} />
        <View className="flex-row gap-2">
          {days.map((date) => (
            <View key={date} testID={`day-${date}`} className="min-w-0 flex-1">
              <DayHeader date={date} today={today} onOpenDay={onOpenDay} centered />
            </View>
          ))}
        </View>
        {slots.map((slot) => (
          <View key={slot} testID={`slot-row-${slot}`} className="flex-row gap-2">
            {days.map((date) => (
              <View key={date} className="min-w-0 flex-1">
                <SlotCell
                  date={date}
                  slot={slot}
                  entries={byDay[date]?.[slot] ?? []}
                  layout="cell"
                  onAdd={() => onAdd(date, slot)}
                  onOpen={onOpenEntry}
                />
              </View>
            ))}
          </View>
        ))}
        {anyMore ? (
          <View testID="more-meals-row" className="flex-row items-start gap-2">
            {days.map((date) => (
              <View key={date} className="min-w-0 flex-1">
                <MoreMealsOfDay
                  date={date}
                  entries={moreByDay[date] ?? []}
                  onOpenEntry={onOpenEntry}
                />
              </View>
            ))}
          </View>
        ) : null}
      </View>
    );
  }

  return (
    <View
      testID="week-grid"
      accessibilityLabel="Week plan, one card per day"
      className="gap-4"
      onLayout={(event) => {
        gridY.current = event.nativeEvent.layout.y;
      }}
    >
      {days.map((date) => (
        <View
          key={date}
          testID={`day-${date}`}
          onLayout={
            date === today
              ? (event) => onTodayOffset?.(gridY.current + event.nativeEvent.layout.y)
              : undefined
          }
          className={`gap-3 rounded-2xl border p-3 ${
            date === today ? "border-brand bg-green-50/40" : "border-neutral-200 bg-white"
          }`}
        >
          <DayHeader date={date} today={today} onOpenDay={onOpenDay} />
          {slots.map((slot) => (
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
          <MoreMealsOfDay date={date} entries={moreByDay[date] ?? []} onOpenEntry={onOpenEntry} />
        </View>
      ))}
    </View>
  );
}

/** The collapsed "More meals" row for a day, or nothing when the day has no such meals. */
function MoreMealsOfDay({
  date,
  entries,
  onOpenEntry,
}: {
  date: string;
  entries: readonly PlanEntry[];
  onOpenEntry: (entry: PlanEntry) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <MoreMeals date={date} count={entries.length}>
      {entries.map((entry) => (
        <EntryChip
          key={entry.id}
          entry={entry}
          onOpen={onOpenEntry}
          slotLabel={SLOT_LABELS[entry.slot]}
        />
      ))}
    </MoreMeals>
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
      // The label starts with what the button shows (WCAG 2.5.3): "Mon Nov 2" in a column header,
      // the long date on a day card.
      accessibilityLabel={`${
        centered ? `${shortDayName(date)} ${shortMonthDay(date)}` : longDate(date)
      }${isToday ? ", today" : ""}. Open the day`}
      onPress={() => onOpenDay(date)}
      className={`min-h-11 justify-center rounded-lg px-2 ${
        centered ? (isToday ? "items-center bg-brand" : "items-center bg-neutral-100") : ""
      }`}
    >
      {centered ? (
        <>
          <Text className={`text-xs font-semibold ${isToday ? "text-white" : "text-neutral-600"}`}>
            {shortDayName(date)}
          </Text>
          <WebSpace />
          <Text className={`text-sm font-bold ${isToday ? "text-white" : "text-neutral-900"}`}>
            {shortMonthDay(date)}
          </Text>
        </>
      ) : (
        <View className="flex-row items-center justify-between">
          <Text className="text-base font-semibold text-neutral-900">{longDate(date)}</Text>
          {isToday ? <WebSpace /> : null}
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
