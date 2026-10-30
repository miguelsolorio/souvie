import { Text, TextInput, type TextInputProps, View } from "react-native";

export interface MultilineFieldProps
  extends Pick<TextInputProps, "value" | "onChangeText" | "placeholder" | "editable" | "testID"> {
  label: string;
  helper?: string;
  error?: string | null;
  /** Rough number of visible lines. */
  lines?: number;
  maxLength?: number;
}

/** A labelled multi-line text box that matches TextField. */
export function MultilineField({
  label,
  helper,
  error,
  lines = 5,
  editable = true,
  maxLength,
  ...input
}: MultilineFieldProps) {
  return (
    <View className="gap-1.5">
      <Text className="text-sm font-medium text-neutral-800">{label}</Text>
      <TextInput
        {...input}
        editable={editable}
        multiline
        textAlignVertical="top"
        maxLength={maxLength}
        accessibilityLabel={label}
        placeholderTextColor="#9ca3af"
        style={{ minHeight: lines * 24 + 24 }}
        className={`rounded-xl border px-4 py-3 text-base text-neutral-900 ${
          error ? "border-red-400" : "border-neutral-300"
        } ${editable ? "bg-white" : "bg-neutral-100 text-neutral-500"}`}
      />
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-red-700">
          {error}
        </Text>
      ) : helper ? (
        <Text className="text-sm text-neutral-500">{helper}</Text>
      ) : null}
    </View>
  );
}
