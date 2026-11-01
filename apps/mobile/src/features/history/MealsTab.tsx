import { HISTORY_LIMITS, isoDateOf, weekStartFor } from "@mp/core";
import { useMealsCooked } from "@mp/db";
import { EmptyState } from "@mp/ui/primitives";
import { Text, View } from "react-native";
import { relativeWeekLabel, weekRangeLabel } from "../plan/format";
import { cookedDayLabel, mealCountLabel, RECIPE_GONE, SLOT_NAME } from "./format";
import { cookedByDay, summarizeCooked } from "./logic";
import { Heading, LoadError, Loading, Stat } from "./parts";

/**
 * Meals cooked, per week (WS12): the entries marked cooked in the planner, grouped by day, with
 * how many this week and the day streak. The week is the plan's own.
 */
export function MealsTab() {
  const meals = useMealsCooked();
  const today = isoDateOf(new Date());

  if (meals.isPending) return <Loading label="Loading what you cooked" />;
  if (meals.isError) {
    return (
      <LoadError message="Could not load your cooked meals." onRetry={() => void meals.refetch()} />
    );
  }

  const weeks = meals.data ?? [];
  if (weeks.length === 0) {
    return (
      <EmptyState
        testID="meals-empty"
        icon="🍳"
        title="Nothing cooked yet"
        message="Mark a meal as cooked in your plan and it shows up here, week by week."
      />
    );
  }

  const summary = summarizeCooked(weeks, today);
  const thisWeek = weekStartFor(today);
  return (
    <View testID="meals-tab" className="gap-5">
      <View className="flex-row gap-3">
        <Stat testID="meals-this-week" value={String(summary.thisWeek)} label="Cooked this week" />
        <Stat
          testID="meals-streak"
          value={String(summary.streak)}
          label={summary.streak === 1 ? "Day in a row" : "Days in a row"}
        />
      </View>
      {weeks.map((week) => (
        <View key={week.week_start} testID={`meals-week-${week.week_start}`} className="gap-3">
          <Heading
            detail={`${weekRangeLabel(week.week_start)} · ${mealCountLabel(week.cooked_count)} cooked`}
          >
            {relativeWeekLabel(week.week_start, thisWeek)}
          </Heading>
          {cookedByDay(week.entries).map((day) => (
            <View key={day.date} className="gap-1 rounded-xl border border-neutral-200 p-3">
              <Text className="text-sm font-semibold text-neutral-700">
                {cookedDayLabel(day.date)}
              </Text>
              {day.meals.map((meal) => (
                <View
                  key={meal.id}
                  testID={`meal-${meal.id}`}
                  accessible
                  accessibilityLabel={`${meal.title ?? RECIPE_GONE}, ${SLOT_NAME[meal.slot]}`}
                  className="min-h-11 flex-row items-center justify-between gap-3"
                >
                  <Text className="flex-1 text-base text-neutral-900">
                    {meal.title ?? RECIPE_GONE}
                  </Text>
                  <Text className="text-sm text-neutral-500">{SLOT_NAME[meal.slot]}</Text>
                </View>
              ))}
            </View>
          ))}
        </View>
      ))}
      <Text className="text-xs text-neutral-500">
        Showing the last {HISTORY_LIMITS.weeks} weeks. A streak counts the days in a row with
        something cooked, so it can reach back only that far.
      </Text>
    </View>
  );
}
