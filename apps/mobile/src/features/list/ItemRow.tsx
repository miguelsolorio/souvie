import type { GroceryListItem } from "@mp/core";
import { Pressable, Text, View } from "react-native";
import { amountLabel, rowAccessibilityLabel } from "./logic";

export type ItemRowMode = "shop" | "have" | "removed";

/**
 * One line of the list.
 *
 *   shop     a check-off row: the whole row toggles, and an info button opens "Why this amount".
 *            `large` makes it a thumb-sized row for in-store mode.
 *   have     an item the pantry covers, with "I'm out" to bring it back.
 *   removed  an item a person took off the list, with "Put back".
 */
export function ItemRow({
  item,
  mode = "shop",
  large = false,
  onToggle,
  onInfo,
  onAction,
}: {
  item: GroceryListItem;
  mode?: ItemRowMode;
  large?: boolean;
  onToggle?: (item: GroceryListItem) => void;
  onInfo?: (item: GroceryListItem) => void;
  onAction?: (item: GroceryListItem) => void;
}) {
  const amount = amountLabel(item);

  if (mode !== "shop") {
    const label = mode === "have" ? "I'm out" : "Put back";
    return (
      <View
        testID={`item-${item.id}`}
        className="min-h-14 flex-row items-center gap-3 border-b border-neutral-100 py-2"
      >
        <View className="flex-1">
          <Text className="text-base text-neutral-700">{item.display_name}</Text>
          {amount ? <Text className="text-xs text-neutral-500">{amount}</Text> : null}
        </View>
        {onAction ? (
          <Pressable
            testID={`item-${item.id}-action`}
            accessibilityRole="button"
            accessibilityLabel={`${label}: ${item.display_name}`}
            onPress={() => onAction(item)}
            className="min-h-11 justify-center rounded-xl border border-neutral-300 px-4"
          >
            <Text className="text-sm font-semibold text-neutral-900">{label}</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  const box = large ? "h-10 w-10" : "h-7 w-7";
  return (
    <View
      className={`flex-row items-center border-b border-neutral-100 ${large ? "min-h-20" : "min-h-14"}`}
    >
      <Pressable
        testID={`item-${item.id}`}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: item.checked }}
        // react-native-web 0.21 writes aria-* props and ignores accessibilityState, so without this
        // a screen reader on the web hears a checkbox that is never checked (WS13).
        aria-checked={item.checked}
        accessibilityLabel={rowAccessibilityLabel(item)}
        onPress={() => onToggle?.(item)}
        // A checkbox is toggled by Space as well as by a click. react-native-web's Pressable
        // answers Enter on any role but Space only on a button, so Space is handled here (WS13).
        onKeyDown={(event) => {
          if (event.nativeEvent.key !== " ") return;
          event.preventDefault();
          onToggle?.(item);
        }}
        className="min-h-11 flex-1 flex-row items-center gap-3 py-2 pr-2"
      >
        <View
          className={`items-center justify-center rounded-full border-2 ${box} ${
            item.checked ? "border-brand bg-brand" : "border-neutral-400 bg-white"
          }`}
        >
          {item.checked ? (
            <Text className={`font-bold text-white ${large ? "text-xl" : "text-sm"}`}>✓</Text>
          ) : null}
        </View>
        <View className="flex-1">
          <Text
            className={`font-medium ${large ? "text-xl" : "text-base"} ${
              item.checked
                ? "text-neutral-400 line-through web:text-neutral-500"
                : "text-neutral-900"
            }`}
          >
            {item.display_name}
          </Text>
          {item.needs_attention && !item.checked ? (
            <Text className="text-xs font-semibold text-amber-700">Needs a look</Text>
          ) : null}
        </View>
        {amount ? (
          <Text
            className={`${large ? "text-lg" : "text-sm"} ${
              item.checked ? "text-neutral-400 web:text-neutral-500" : "text-neutral-600"
            }`}
          >
            {amount}
          </Text>
        ) : null}
      </Pressable>
      {onInfo ? (
        <Pressable
          testID={`item-${item.id}-info`}
          accessibilityRole="button"
          accessibilityLabel={`Why this amount: ${item.display_name}`}
          onPress={() => onInfo(item)}
          className="h-11 w-11 items-center justify-center"
        >
          <Text className={`text-neutral-500 ${large ? "text-2xl" : "text-lg"}`}>ⓘ</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
