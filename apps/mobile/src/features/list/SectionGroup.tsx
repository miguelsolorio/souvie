import { type ReactNode, useState } from "react";
import { Pressable, Text, View } from "react-native";

/**
 * A titled group of rows: a store section ("Produce"), or "Already have". With `collapsible` the
 * header is a button that folds the rows away; `defaultCollapsed` starts it folded.
 */
export function SectionGroup({
  title,
  count,
  children,
  collapsible = false,
  defaultCollapsed = false,
  large = false,
  testID,
}: {
  title: string;
  count?: number;
  children: ReactNode;
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  large?: boolean;
  testID?: string;
}) {
  const [collapsed, setCollapsed] = useState(collapsible && defaultCollapsed);
  const heading = (
    <View className="flex-row items-center gap-2">
      <Text
        accessibilityRole="header"
        className={`font-bold uppercase tracking-wide text-neutral-500 ${large ? "text-base" : "text-xs"}`}
      >
        {title}
      </Text>
      {count === undefined ? null : (
        <Text className={`text-neutral-400 ${large ? "text-base" : "text-xs"}`}>{count}</Text>
      )}
      {collapsible ? (
        <Text className="ml-auto text-xs text-neutral-500">{collapsed ? "Show" : "Hide"}</Text>
      ) : null}
    </View>
  );

  return (
    <View testID={testID} className="gap-1">
      {collapsible ? (
        <Pressable
          testID={testID ? `${testID}-toggle` : undefined}
          accessibilityRole="button"
          accessibilityState={{ expanded: !collapsed }}
          accessibilityLabel={`${title}, ${count ?? 0} items, ${collapsed ? "show" : "hide"}`}
          onPress={() => setCollapsed((value) => !value)}
          className="min-h-11 justify-center"
        >
          {heading}
        </Pressable>
      ) : (
        <View className="min-h-9 justify-end pb-1">{heading}</View>
      )}
      {collapsed ? null : <View>{children}</View>}
    </View>
  );
}
