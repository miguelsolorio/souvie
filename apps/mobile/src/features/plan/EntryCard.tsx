import type { PlanEntry } from "@mp/db";
import { Pressable, Text, View } from "react-native";
import { RecipeImage } from "../recipes/RecipeImage";
import { entryA11yLabel, entryTitle, STATUS_LABELS, servingsLabel } from "./format";

/**
 * A planned meal on the day screen: the recipe's picture, its name, servings, status, and any
 * note. Larger than the week view's chip because the day screen has the room.
 */
export function EntryCard({
  entry,
  onOpen,
}: {
  entry: PlanEntry;
  onOpen: (entry: PlanEntry) => void;
}) {
  const cooked = entry.status === "cooked";
  const skipped = entry.status === "skipped";
  const times = [
    entry.recipe?.prep_min ? `Prep ${entry.recipe.prep_min} min` : null,
    entry.recipe?.cook_min ? `Cook ${entry.recipe.cook_min} min` : null,
  ].filter(Boolean);

  return (
    <Pressable
      testID={`entry-${entry.id}`}
      accessibilityRole="button"
      accessibilityLabel={entryA11yLabel(entry)}
      accessibilityHint="Opens the meal to change servings, swap, or mark it cooked"
      onPress={() => onOpen(entry)}
      className={`flex-row items-center gap-3 rounded-2xl border p-3 ${
        cooked ? "border-green-300 bg-green-50" : "border-neutral-200 bg-white"
      } ${skipped ? "opacity-60" : ""}`}
    >
      <RecipeImage
        imageUrl={entry.recipe?.image_url}
        title={entryTitle(entry)}
        width={64}
        height={64}
      />
      <View className="flex-1 gap-0.5">
        <Text
          className={`text-base font-semibold text-neutral-900 ${skipped ? "line-through" : ""}`}
          numberOfLines={2}
        >
          {entryTitle(entry)}
        </Text>
        <Text className="text-sm text-neutral-600">
          {[
            servingsLabel(entry.servings),
            ...times,
            entry.status === "planned" ? null : STATUS_LABELS[entry.status],
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
        {entry.notes ? (
          <Text className="text-sm italic text-neutral-600" numberOfLines={2}>
            {entry.notes}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}
