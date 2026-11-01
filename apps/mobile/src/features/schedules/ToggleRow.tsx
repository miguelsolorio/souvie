import { Pressable, Text, View } from "react-native";

/**
 * A labelled on/off switch drawn from plain views, so it looks the same on a phone and on the web.
 * One 48 point tall target; for a screen reader it is a single "switch" that says whether it is on.
 */
export function ToggleRow({
  label,
  description,
  value,
  onChange,
  disabled = false,
  testID,
}: {
  label: string;
  description?: string | undefined;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  testID?: string | undefined;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityHint={description}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={() => onChange(!value)}
      className={`min-h-12 flex-row items-center gap-3 py-2 ${disabled ? "opacity-50" : ""}`}
    >
      <View className="flex-1 gap-0.5">
        <Text className="text-base font-medium text-neutral-900">{label}</Text>
        {description ? <Text className="text-sm text-neutral-500">{description}</Text> : null}
      </View>
      <View
        className={`h-7 w-12 justify-center rounded-full px-0.5 ${value ? "bg-brand" : "bg-neutral-300"}`}
      >
        <View className={`h-6 w-6 rounded-full bg-white ${value ? "self-end" : "self-start"}`} />
      </View>
    </Pressable>
  );
}
