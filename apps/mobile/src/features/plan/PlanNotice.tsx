import { useIsMutating } from "@tanstack/react-query";
import { Pressable, Text, View } from "react-native";
import { clearPlanNotice, usePlanNotice } from "./notice";

/** A dismissible line for a save that failed for good. Renders nothing when there is none. */
export function PlanNoticeBar() {
  const { message } = usePlanNotice();
  if (!message) return null;
  return (
    <View
      testID="plan-notice"
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
      className="flex-row items-center gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3"
    >
      <Text className="flex-1 text-sm text-red-800">{message}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Dismiss message"
        onPress={clearPlanNotice}
        hitSlop={8}
        className="min-h-9 justify-center px-2"
      >
        <Text className="text-sm font-semibold text-red-800">Dismiss</Text>
      </Pressable>
    </View>
  );
}

/**
 * "Saving..." while any planner change is on its way to the server, including one that is
 * waiting for the connection to come back. A change shows on screen the moment it is made; this
 * says it is not safe on the server yet.
 */
export function SyncStatus() {
  const pending = useIsMutating();
  if (pending === 0) return null;
  return (
    <Text
      testID="sync-status"
      accessibilityLiveRegion="polite"
      className="text-xs font-medium text-neutral-500"
    >
      Saving...
    </Text>
  );
}
