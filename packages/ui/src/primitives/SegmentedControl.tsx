import { Pressable, StyleSheet, Text, View } from "react-native";
import { MIN_TARGET } from "./logic";
import { colors, radius, textStyle } from "./theme";

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  /** Overrides the spoken name when the label alone is too short ("Fav" -> "Favorites"). */
  accessibilityLabel?: string;
  testID?: string;
}

export interface SegmentedControlProps<T extends string> {
  options: ReadonlyArray<SegmentOption<T>>;
  value: T;
  onChange: (value: T) => void;
  /** What the control chooses between, for screen readers: "Recipe list". */
  label: string;
  testID?: string;
}

/**
 * Two to four mutually exclusive choices that share a row, such as Recent, Favorites, All. The
 * selected segment is announced as selected and is not a second tap target for itself.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  testID,
}: SegmentedControlProps<T>) {
  return (
    <View
      testID={testID}
      accessibilityRole="tablist"
      accessibilityLabel={label}
      style={styles.track}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            testID={option.testID}
            accessibilityRole="tab"
            accessibilityLabel={option.accessibilityLabel ?? option.label}
            accessibilityState={{ selected }}
            onPress={() => {
              if (!selected) onChange(option.value);
            }}
            style={[styles.segment, selected && styles.segmentSelected]}
          >
            <Text style={[styles.text, selected && styles.textSelected]} numberOfLines={1}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: "row",
    padding: 3,
    gap: 3,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSunken,
  },
  segment: {
    flex: 1,
    minHeight: MIN_TARGET - 6,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 8,
    borderRadius: radius.md,
  },
  segmentSelected: {
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  text: { ...textStyle("caption"), color: colors.textMuted },
  textSelected: { color: colors.text, fontWeight: "700" },
});
