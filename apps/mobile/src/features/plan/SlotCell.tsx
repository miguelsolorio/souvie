import type { MealSlot } from "@mp/core";
import type { PlanEntry } from "@mp/db";
import { type ReactNode, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  dayName,
  entryA11yLabel,
  entryTitle,
  SLOT_LABELS,
  servingsLabel,
  slotTitle,
} from "./format";
import { MORE_MEALS_LABEL } from "./mode";

/**
 * One meal slot on one day: its entries, and a button to add another. `layout="row"` is the
 * phone's list (the slot name on the left, entries on the right); `layout="cell"` is a cell in a
 * wide column (the slot name on top).
 */
export function SlotCell({
  date,
  slot,
  entries,
  layout,
  onAdd,
  onOpen,
}: {
  date: string;
  slot: MealSlot;
  entries: readonly PlanEntry[];
  layout: "row" | "cell";
  onAdd: () => void;
  onOpen: (entry: PlanEntry) => void;
}) {
  const label = SLOT_LABELS[slot];
  const cell = layout === "cell";

  return (
    <View
      testID={`slot-${date}-${slot}`}
      className={cell ? "flex-1 gap-2 rounded-xl bg-neutral-50 p-2" : "flex-row items-start gap-3"}
    >
      <Text
        className={
          cell
            ? "px-1 text-xs font-semibold uppercase tracking-wide text-neutral-500"
            : "w-20 pt-3 text-sm font-medium text-neutral-600"
        }
      >
        {label}
      </Text>
      <View className={cell ? "gap-2" : "flex-1 gap-2"}>
        {entries.map((entry) => (
          <EntryChip key={entry.id} entry={entry} onOpen={onOpen} />
        ))}
        <Pressable
          testID={`add-${date}-${slot}`}
          accessibilityRole="button"
          accessibilityLabel={`Add a recipe to ${slotTitle(date, slot)}`}
          onPress={onAdd}
          className={`min-h-11 flex-row items-center justify-center rounded-xl border border-dashed border-neutral-300 px-3 ${
            entries.length > 0 ? "py-1.5" : "py-2.5"
          }`}
        >
          <Text className="text-sm font-medium text-brand">
            {entries.length > 0 ? "+ Add another" : "+ Add"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

/**
 * The "More meals" row under a day in Just dinners mode: the meals planned in slots the mode does
 * not draw (a lunch from Every meal mode, or one a housemate added before the switch). It starts
 * collapsed, shows how many are inside, and opens to the meals themselves, which the caller
 * passes as children. It exists only for a day that has such meals; nothing is ever dropped.
 */
export function MoreMeals({
  date,
  count,
  defaultOpen = false,
  children,
}: {
  date: string;
  count: number;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <View testID={`more-meals-${date}`} className="gap-2">
      <Pressable
        testID={`more-meals-toggle-${date}`}
        accessibilityRole="button"
        accessibilityLabel={`${count} more ${count === 1 ? "meal" : "meals"} on ${dayName(date)}`}
        accessibilityHint={open ? "Hides them" : "Shows them"}
        accessibilityState={{ expanded: open }}
        aria-expanded={open}
        onPress={() => setOpen((was) => !was)}
        className="min-h-11 flex-row items-center justify-between gap-2 rounded-xl border border-neutral-200 bg-neutral-50 px-3"
      >
        <Text className="text-sm font-medium text-neutral-700">{MORE_MEALS_LABEL}</Text>
        <View className="flex-row items-center gap-2">
          <Text className="rounded-full bg-neutral-200 px-2 py-0.5 text-xs font-semibold text-neutral-700">
            {count}
          </Text>
          <Text className="text-sm text-neutral-500">{open ? "▴" : "▾"}</Text>
        </View>
      </Pressable>
      {open ? (
        <View testID={`more-meals-list-${date}`} className="gap-2">
          {children}
        </View>
      ) : null}
    </View>
  );
}

/**
 * One planned recipe. Cooked meals are tinted, skipped meals are struck through and dimmed.
 * `slotLabel` names the meal ("Lunch") above the title, for meals shown outside their own slot.
 */
export function EntryChip({
  entry,
  onOpen,
  slotLabel,
}: {
  entry: PlanEntry;
  onOpen: (entry: PlanEntry) => void;
  slotLabel?: string;
}) {
  const cooked = entry.status === "cooked";
  const skipped = entry.status === "skipped";
  return (
    <Pressable
      testID={`entry-${entry.id}`}
      accessibilityRole="button"
      accessibilityLabel={
        slotLabel ? `${slotLabel}, ${entryA11yLabel(entry)}` : entryA11yLabel(entry)
      }
      accessibilityHint="Opens the meal to change servings, swap, or mark it cooked"
      onPress={() => onOpen(entry)}
      className={`min-h-12 gap-0.5 rounded-xl border px-3 py-2 ${
        cooked ? "border-green-300 bg-green-50" : "border-neutral-200 bg-white"
      } ${skipped ? "opacity-60" : ""}`}
    >
      {slotLabel ? (
        <Text className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          {slotLabel}
        </Text>
      ) : null}
      <Text
        className={`text-sm font-semibold text-neutral-900 ${skipped ? "line-through" : ""}`}
        numberOfLines={2}
      >
        {entryTitle(entry)}
      </Text>
      <Text className="text-xs text-neutral-600">
        {[servingsLabel(entry.servings), cooked ? "Cooked" : skipped ? "Skipped" : null]
          .filter(Boolean)
          .join(" · ")}
      </Text>
    </Pressable>
  );
}
