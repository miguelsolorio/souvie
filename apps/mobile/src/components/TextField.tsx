import { Text, TextInput, type TextInputProps, View } from "react-native";

export interface TextFieldProps
  extends Pick<
    TextInputProps,
    | "value"
    | "onChangeText"
    | "placeholder"
    | "editable"
    | "keyboardType"
    | "autoCapitalize"
    | "autoComplete"
    | "autoCorrect"
    | "textContentType"
    | "maxLength"
    | "returnKeyType"
    | "onSubmitEditing"
    | "testID"
  > {
  label: string;
  helper?: string;
  error?: string | null;
}

export function TextField({ label, helper, error, editable = true, ...input }: TextFieldProps) {
  return (
    <View className="gap-1.5">
      <Text className="text-sm font-medium text-neutral-800">{label}</Text>
      <TextInput
        {...input}
        editable={editable}
        accessibilityLabel={label}
        placeholderTextColor="#9ca3af"
        className={`min-h-12 rounded-xl border px-4 text-base text-neutral-900 ${
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
