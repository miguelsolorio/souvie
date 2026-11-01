// Small pieces the History screens share (WS12).
import { ActivityIndicator, Text, View } from "react-native";
import { Button } from "../../components/Button";

/** A load that is under way. */
export function Loading({ label }: { label: string }) {
  return (
    <View testID="history-loading" className="items-center gap-2 py-8">
      <ActivityIndicator color="#2F6B4F" />
      <Text className="text-sm text-neutral-500">{label}</Text>
    </View>
  );
}

/** A load that failed, with a way to try again. */
export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <View testID="history-error" className="gap-3 rounded-xl border border-red-200 bg-red-50 p-4">
      <Text accessibilityRole="alert" className="text-base text-red-800">
        {message}
      </Text>
      <Button label="Try again" variant="secondary" onPress={onRetry} />
    </View>
  );
}

/** A number with a caption under it: "3" over "Cooked this week". */
export function Stat({ value, label, testID }: { value: string; label: string; testID?: string }) {
  return (
    <View
      testID={testID}
      accessible
      accessibilityLabel={`${label}: ${value}`}
      className="flex-1 gap-1 rounded-xl bg-neutral-50 p-4"
    >
      <Text className="text-3xl font-bold text-neutral-900">{value}</Text>
      <Text className="text-sm text-neutral-600">{label}</Text>
    </View>
  );
}

/** A heading over a block of rows. */
export function Heading({ children, detail }: { children: string; detail?: string }) {
  return (
    <View className="gap-0.5">
      <Text accessibilityRole="header" className="text-lg font-semibold text-neutral-900">
        {children}
      </Text>
      {detail ? <Text className="text-sm text-neutral-500">{detail}</Text> : null}
    </View>
  );
}

/** The sentence every empty History tab uses (docs/workstreams/WS12 acceptance 6). */
export const NO_ORDERS_TITLE = "No orders yet";
export const NO_ORDERS_MESSAGE =
  "Orders appear here after you confirm a shopping run. Stores do not share order history with apps yet.";
