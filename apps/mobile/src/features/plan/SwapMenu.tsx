import { weekStartFor } from "@mp/core";
import { type PlanEntry, useRecipes, useSupabase } from "@mp/db";
import { useMutation } from "@tanstack/react-query";
import { Text, View } from "react-native";
import { Button } from "../../components/Button";
import { isSuggestEnabled, requestSwapSuggestion, SuggestUnavailableError } from "./suggest";
import type { usePlanActions } from "./usePlanActions";

/**
 * How to replace the recipe in a slot. "Pick a recipe" is always there. "Suggest one" appears only
 * when the suggest function is deployed (EXPO_PUBLIC_SUGGEST_ENABLED), and asks it for a single
 * recipe that fits this slot and repeats nothing else this week. The suggestion is applied through
 * the same save as a manual swap.
 */
export function SwapMenu({
  entry,
  weekEntries,
  actions,
  onPick,
  onDone,
  onBack,
}: {
  entry: PlanEntry;
  /** The week's entries, so a suggestion can avoid repeating one. */
  weekEntries: readonly PlanEntry[];
  actions: ReturnType<typeof usePlanActions>;
  /** Opens the manual recipe picker for this entry. */
  onPick: () => void;
  /** Called once a suggestion has been applied. */
  onDone: () => void;
  onBack: () => void;
}) {
  const client = useSupabase();
  const recipes = useRecipes(entry.household_id);
  const suggestEnabled = isSuggestEnabled();

  const suggest = useMutation({
    mutationFn: async () => {
      const result = await requestSwapSuggestion(client, {
        householdId: entry.household_id,
        weekStart: weekStartFor(entry.date),
        date: entry.date,
        slot: entry.slot,
        excludeRecipeIds: [...new Set(weekEntries.map((other) => other.recipe_id))],
      });
      const recipe = recipes.data?.find((candidate) => candidate.id === result.recipeId);
      if (!recipe) throw new Error("That suggestion is not in your recipes.");
      return { recipe, result };
    },
    onSuccess: ({ recipe, result }) => {
      actions.swapRecipe(entry, recipe, { servings: result.servings, why: result.why });
      onDone();
    },
  });

  const unavailable = suggest.error instanceof SuggestUnavailableError;

  return (
    <View testID="swap-menu" className="gap-3">
      <Text className="text-base text-neutral-700">
        Choose a different recipe for this meal. Servings and notes stay.
      </Text>
      <Button testID="swap-pick" label="Pick a recipe" onPress={onPick} />
      {suggestEnabled ? (
        <Button
          testID="swap-suggest"
          label="Suggest one for me"
          variant="secondary"
          loading={suggest.isPending}
          disabled={recipes.isPending}
          onPress={() => suggest.mutate()}
        />
      ) : null}
      {suggest.isError ? (
        <Text accessibilityRole="alert" className="text-sm text-red-700">
          {unavailable
            ? "Suggestions are not available right now. Pick a recipe instead."
            : "Could not get a suggestion. Try again or pick a recipe."}
        </Text>
      ) : null}
      <Button testID="swap-back" label="Back" variant="ghost" onPress={onBack} />
    </View>
  );
}
