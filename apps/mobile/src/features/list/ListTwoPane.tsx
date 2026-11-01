import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { type PaneEntry, paneAccessibilityLabel } from "./panes";

/**
 * The grocery list at the desktop breakpoint (WS13): store sections down the left, the items of
 * the chosen section on the right. `entries` is the left pane (see panes.ts), `children` is the
 * right pane, and `footer` sits under the sections for the list's actions (rebuild, aisle order,
 * pantry, mark as shopped).
 *
 * The left pane is a tab list, the right pane its panel, the same pattern the add-recipe screen
 * uses. Every tab is a button that Tab reaches and Enter or Space presses.
 */
export function ListTwoPane({
  entries,
  selected,
  onSelect,
  footer,
  children,
}: {
  entries: readonly PaneEntry[];
  selected: string;
  onSelect: (key: string) => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <View testID="list-two-pane" className="flex-row items-start gap-8">
      <View className="w-64 shrink-0 gap-4">
        <View testID="list-pane-nav" role="tablist" aria-label="Store sections" className="gap-1">
          {entries.map((entry) => {
            const isSelected = entry.key === selected;
            return (
              <Pressable
                key={entry.key}
                testID={`list-pane-${entry.key}`}
                accessibilityRole="tab"
                accessibilityState={{ selected: isSelected }}
                aria-selected={isSelected}
                accessibilityLabel={paneAccessibilityLabel(entry)}
                onPress={() => onSelect(entry.key)}
                className={`min-h-11 flex-row items-center justify-between gap-3 rounded-xl px-3 ${
                  isSelected ? "bg-green-50" : "bg-transparent"
                }`}
              >
                <Text
                  className={`flex-1 text-base ${
                    isSelected ? "font-semibold text-brand" : "text-neutral-800"
                  }`}
                  numberOfLines={1}
                >
                  {entry.label}
                </Text>
                {/*
                  The count is in the tab's spoken label, so it is hidden from the reading. The
                  leading space is collapsed on screen but keeps "Produce 3" from reading as
                  "Produce3" to tools that join the text of side by side boxes, which is how a
                  label that must contain the visible words (WCAG 2.5.3) is checked.
                */}
                <Text
                  aria-hidden
                  className={`text-sm ${isSelected ? "font-semibold text-brand" : "text-neutral-500"}`}
                >
                  {` ${entry.remaining}`}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {footer}
      </View>
      <View
        testID="list-pane-items"
        role="tabpanel"
        aria-label="Items"
        className="min-w-0 flex-1 gap-5"
      >
        {children}
      </View>
    </View>
  );
}
