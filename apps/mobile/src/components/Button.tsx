import { ActivityIndicator, Pressable, Text } from "react-native";

type Variant = "primary" | "secondary" | "danger" | "ghost";

const CONTAINER: Record<Variant, string> = {
  primary: "bg-brand",
  secondary: "border border-neutral-300 bg-white",
  danger: "border border-red-300 bg-white",
  ghost: "bg-transparent",
};

const LABEL: Record<Variant, string> = {
  primary: "text-white",
  secondary: "text-neutral-900",
  danger: "text-red-700",
  ghost: "text-brand",
};

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: Variant;
  loading?: boolean;
  disabled?: boolean;
  testID?: string;
}

export function Button({
  label,
  onPress,
  variant = "primary",
  loading = false,
  disabled = false,
  testID,
}: ButtonProps) {
  const inactive = disabled || loading;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      onPress={onPress}
      className={`min-h-12 flex-row items-center justify-center rounded-xl px-5 py-3 ${CONTAINER[variant]} ${inactive ? "opacity-50" : ""}`}
    >
      {loading ? (
        <ActivityIndicator color={variant === "primary" ? "#ffffff" : "#2F6B4F"} />
      ) : (
        <Text className={`text-base font-semibold ${LABEL[variant]}`}>{label}</Text>
      )}
    </Pressable>
  );
}
