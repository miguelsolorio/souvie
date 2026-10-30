import type { MealSlot } from "@mp/core";
import type { PlanEntry } from "@mp/db";
import { Pressable, Text, View } from "react-native";
import { entryA11yLabel, entryTitle, SLOT_LABELS, servingsLabel, slotTitle } from "./format";

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
      className={cell ? "gap-2 rounded-xl bg-neutral-50 p-2" : "flex-row items-start gap-3"}
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

/** One planned recipe. Cooked meals are tinted, skipped meals are struck through and dimmed. */
export function EntryChip({
  entry,
  onOpen,
}: {
  entry: PlanEntry;
  onOpen: (entry: PlanEntry) => void;
}) {
  const cooked = entry.status === "cooked";
  const skipped = entry.status === "skipped";
  return (
    <Pressable
      testID={`entry-${entry.id}`}
      accessibilityRole="button"
      accessibilityLabel={entryA11yLabel(entry)}
      accessibilityHint="Opens the meal to change servings, swap, or mark it cooked"
      onPress={() => onOpen(entry)}
      className={`min-h-12 gap-0.5 rounded-xl border px-3 py-2 ${
        cooked ? "border-green-300 bg-green-50" : "border-neutral-200 bg-white"
      } ${skipped ? "opacity-60" : ""}`}
    >
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
