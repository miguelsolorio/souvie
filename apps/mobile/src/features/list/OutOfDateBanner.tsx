import { Text, View } from "react-native";
import { Button } from "../../components/Button";

/**
 * "List is out of date": the plan changed after the list was built. One tap rebuilds it; checked
 * items, items you added, and amounts you changed stay. It is announced politely when it appears.
 */
export function OutOfDateBanner({
  onRebuild,
  rebuilding,
  error,
}: {
  onRebuild: () => void;
  rebuilding: boolean;
  error?: string | null;
}) {
  return (
    <View
      testID="list-out-of-date"
      accessibilityLiveRegion="polite"
      className="gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4"
    >
      <View className="gap-1">
        <Text accessibilityRole="header" className="text-base font-bold text-amber-900">
          List is out of date
        </Text>
        <Text className="text-sm text-amber-900">
          The plan changed after this list was built. Rebuild to pick up the changes. Items you
          checked off, items you added, and amounts you changed stay as they are.
        </Text>
      </View>
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-red-700">
          {error}
        </Text>
      ) : null}
      <Button testID="list-rebuild" label="Rebuild list" loading={rebuilding} onPress={onRebuild} />
    </View>
  );
}
