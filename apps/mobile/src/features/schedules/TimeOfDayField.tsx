import { SegmentedControl, Stepper } from "@mp/ui/primitives";
import { Text, View } from "react-native";
import { clockText, from12h, to12h } from "./logic";

type Minute = "0" | "15" | "30" | "45" | "other";
type Meridiem = "am" | "pm";

const MINUTES: ReadonlyArray<{ value: Minute; label: string }> = [
  { value: "0", label: ":00" },
  { value: "15", label: ":15" },
  { value: "30", label: ":30" },
  { value: "45", label: ":45" },
];

/**
 * A time of day: the hour on a stepper, the quarter hour and AM or PM on segmented controls, and
 * the result in words underneath. A minute set outside the app (say 9:05) shows no quarter chosen
 * until one is picked; the words always say the exact time.
 */
export function TimeOfDayField({
  label,
  hour,
  minute,
  onChange,
  disabled = false,
  testID = "time",
}: {
  label: string;
  /** 0 to 23. */
  hour: number;
  minute: number;
  onChange: (hour: number, minute: number) => void;
  disabled?: boolean;
  testID?: string;
}) {
  const clock = to12h(hour);
  const quarter: Minute =
    minute === 0 || minute === 15 || minute === 30 || minute === 45
      ? (String(minute) as Minute)
      : "other";
  return (
    <View testID={testID} accessibilityLabel={label} className="gap-3">
      <View className="flex-row items-center justify-between">
        <Text className="text-sm font-medium text-neutral-800">{label}</Text>
        <Text testID={`${testID}-text`} className="text-base font-semibold text-neutral-900">
          {clockText(hour, minute)}
        </Text>
      </View>
      <Stepper
        testID={`${testID}-hour`}
        label="Hour"
        unit="o'clock"
        unitPlural="o'clock"
        value={clock.hour}
        min={1}
        max={12}
        step={1}
        disabled={disabled}
        onChange={(next) => onChange(from12h({ hour: next, pm: clock.pm }), minute)}
      />
      <SegmentedControl<Minute>
        testID={`${testID}-minute`}
        label="Minutes"
        options={MINUTES}
        value={quarter}
        onChange={(next) => {
          if (!disabled && next !== "other") onChange(hour, Number(next));
        }}
      />
      <SegmentedControl<Meridiem>
        testID={`${testID}-meridiem`}
        label="AM or PM"
        options={[
          { value: "am", label: "AM" },
          { value: "pm", label: "PM" },
        ]}
        value={clock.pm ? "pm" : "am"}
        onChange={(next) => {
          if (!disabled) onChange(from12h({ hour: clock.hour, pm: next === "pm" }), minute);
        }}
      />
    </View>
  );
}
