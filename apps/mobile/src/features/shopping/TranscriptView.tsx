import { Text, View } from "react-native";
import { type TranscriptEntry, transcriptLines } from "./logic";

/**
 * Every step the shopper took, oldest first: searches, choices, cart adds. The transcript names
 * list lines and counts, never product data, so it reads the same after the cart is cleared.
 */
export function TranscriptView({ entries }: { entries: readonly TranscriptEntry[] }) {
  const lines = transcriptLines(entries);
  if (lines.length === 0) {
    return <Text className="text-sm text-neutral-500">No steps yet.</Text>;
  }
  return (
    <View testID="run-transcript" className="gap-2">
      {lines.map((line) => (
        <View key={line.key} className="flex-row gap-3">
          <Text className="w-16 text-xs text-neutral-400">{line.time}</Text>
          <View className="flex-1">
            <Text
              className={`text-xs font-semibold ${line.ok ? "text-neutral-700" : "text-red-700"}`}
            >
              {line.who}: {line.tool}
            </Text>
            <Text className="text-sm text-neutral-600">{line.text}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}
