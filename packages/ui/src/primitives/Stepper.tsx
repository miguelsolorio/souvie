import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  canStep,
  formatStepValue,
  MIN_TARGET,
  type StepBounds,
  stepperSpeech,
  stepValue,
} from "./logic";
import { colors, radius, textStyle } from "./theme";

export interface StepperProps {
  value: number;
  onChange: (value: number) => void;
  /** What the control changes, for screen readers: "Servings". */
  label: string;
  min?: number;
  max?: number;
  step?: number;
  /** Spoken after the number: "serving". */
  unit?: string;
  unitPlural?: string;
  disabled?: boolean;
  testID?: string;
}

/**
 * A number with minus and plus buttons. Each button is a 44 point target. For a screen reader the
 * whole control is one adjustable element (swipe up and down to change it), and the buttons are
 * still there for everyone else.
 */
export function Stepper({
  value,
  onChange,
  label,
  min = 1,
  max = 100,
  step = 1,
  unit,
  unitPlural,
  disabled = false,
  testID,
}: StepperProps) {
  const bounds: StepBounds = { min, max, step };
  const canDown = !disabled && canStep(value, -1, bounds);
  const canUp = !disabled && canStep(value, 1, bounds);
  const change = (direction: 1 | -1) => onChange(stepValue(value, direction, bounds));

  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ min, max, now: value, text: stepperSpeech(value, unit, unitPlural) }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === "increment" && canUp) change(1);
        if (event.nativeEvent.actionName === "decrement" && canDown) change(-1);
      }}
      style={styles.row}
    >
      <StepButton
        glyph="−"
        label={`Decrease ${label.toLowerCase()}`}
        enabled={canDown}
        onPress={() => change(-1)}
        testID={testID ? `${testID}-minus` : undefined}
      />
      <Text
        accessibilityLiveRegion="polite"
        style={[styles.value, disabled && styles.valueDisabled]}
        testID={testID ? `${testID}-value` : undefined}
      >
        {formatStepValue(value)}
      </Text>
      <StepButton
        glyph="+"
        label={`Increase ${label.toLowerCase()}`}
        enabled={canUp}
        onPress={() => change(1)}
        testID={testID ? `${testID}-plus` : undefined}
      />
    </View>
  );
}

function StepButton(props: {
  glyph: string;
  label: string;
  enabled: boolean;
  onPress: () => void;
  testID: string | undefined;
}) {
  return (
    <Pressable
      testID={props.testID}
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: !props.enabled }}
      disabled={!props.enabled}
      onPress={props.onPress}
      hitSlop={4}
      style={({ pressed }) => [
        styles.button,
        pressed && styles.buttonPressed,
        !props.enabled && styles.buttonDisabled,
      ]}
    >
      <Text style={[styles.glyph, !props.enabled && styles.glyphDisabled]}>{props.glyph}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 4 },
  button: {
    minWidth: MIN_TARGET,
    minHeight: MIN_TARGET,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surfaceRaised,
  },
  buttonPressed: { backgroundColor: colors.surfaceSunken },
  buttonDisabled: { borderColor: colors.border, backgroundColor: colors.surface },
  glyph: { ...textStyle("title"), color: colors.text },
  glyphDisabled: { color: colors.textMuted, opacity: 0.5 },
  value: {
    ...textStyle("title"),
    minWidth: 48,
    textAlign: "center",
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  valueDisabled: { color: colors.textMuted },
});
