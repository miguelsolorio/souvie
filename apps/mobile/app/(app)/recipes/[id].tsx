import { instructionsToSteps } from "@mp/core";
import { recipeErrorMessage, useDeleteRecipe, useRecipe } from "@mp/db";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { Text, View } from "react-native";
import { Button } from "../../../src/components/Button";
import { ErrorText, LoadingScreen, Screen, Section } from "../../../src/components/Screen";
import {
  formatMinutes,
  formatServings,
  groupIngredientLines,
  numberSteps,
} from "../../../src/features/recipes/format";
import { RecipeImage } from "../../../src/features/recipes/RecipeImage";
import { SourceLine } from "../../../src/features/recipes/SourceLine";
import { confirmAction } from "../../../src/lib/confirm";

/** One recipe: ingredients, steps, and where it came from. */
export default function RecipeDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const recipe = useRecipe(id);
  const remove = useDeleteRecipe();
  const [error, setError] = useState<string | null>(null);

  if (recipe.isPending) return <LoadingScreen />;

  if (recipe.isError) {
    return (
      <Screen title="Recipe">
        <Text accessibilityRole="alert" className="text-base text-red-700">
          Could not load this recipe.
        </Text>
        <Button label="Try again" onPress={() => void recipe.refetch()} />
      </Screen>
    );
  }

  const data = recipe.data;
  if (!data) {
    return (
      <Screen title="Recipe not found">
        <Stack.Screen options={{ title: "Recipe" }} />
        <Text className="text-base text-neutral-700">
          This recipe was deleted, or you do not have access to it.
        </Text>
        <Button label="Back to recipes" onPress={() => router.replace("/recipes")} />
      </Screen>
    );
  }

  const groups = groupIngredientLines(data.ingredients);
  const steps = numberSteps(instructionsToSteps(data.instructions));
  const facts = [
    formatServings(data.servings),
    data.prep_min ? `Prep ${formatMinutes(data.prep_min)}` : null,
    data.cook_min ? `Cook ${formatMinutes(data.cook_min)}` : null,
    data.cuisine,
  ].filter((part): part is string => Boolean(part));

  async function confirmDelete() {
    const ok = await confirmAction({
      title: "Delete recipe",
      message: `"${data?.title}" will be removed from your household's recipes.`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok || !id) return;
    setError(null);
    remove.mutate(id, {
      onSuccess: () => router.replace("/recipes"),
      onError: (cause) => setError(recipeErrorMessage(cause)),
    });
  }

  return (
    <Screen title={data.title}>
      <Stack.Screen options={{ title: "Recipe" }} />
      {data.image_url ? (
        <RecipeImage imageUrl={data.image_url} title={data.title} width={320} height={200} />
      ) : null}

      <View className="gap-2">
        {facts.length > 0 ? (
          <Text className="text-base text-neutral-700">{facts.join(" · ")}</Text>
        ) : null}
        <SourceLine sourceType={data.source_type} sourceUrl={data.source_url} />
        {data.tags.length > 0 ? (
          <Text className="text-sm text-neutral-500">
            {data.tags.map((t) => `#${t}`).join("  ")}
          </Text>
        ) : null}
      </View>

      {data.description ? (
        <Text className="text-base text-neutral-700">{data.description}</Text>
      ) : null}

      <Section title="Ingredients">
        <View testID="recipe-ingredients" className="gap-4">
          {groups.map((group) => (
            <View key={group.key} className="gap-2">
              {group.name ? (
                <Text className="text-base font-semibold text-neutral-900">{group.name}</Text>
              ) : null}
              {group.lines.map((line) => (
                <Text key={line.id} className="text-base text-neutral-800">
                  {`• ${line.raw_text}`}
                </Text>
              ))}
            </View>
          ))}
        </View>
      </Section>

      <Section title="Steps">
        {steps.length > 0 ? (
          <View testID="recipe-steps" className="gap-3">
            {steps.map((step) => (
              <View key={step.n} className="flex-row gap-3">
                <Text className="w-6 text-base font-semibold text-brand">{step.n}.</Text>
                <Text className="flex-1 text-base text-neutral-800">{step.text}</Text>
              </View>
            ))}
          </View>
        ) : (
          <Text className="text-base text-neutral-500">
            No steps were found. Edit the recipe to add them.
          </Text>
        )}
      </Section>

      <View className="gap-3">
        <Button
          testID="edit-recipe"
          label="Edit recipe"
          variant="secondary"
          onPress={() => router.push(`/recipes/${data.id}/edit`)}
        />
        <Button
          testID="delete-recipe"
          label="Delete recipe"
          variant="danger"
          loading={remove.isPending}
          onPress={() => void confirmDelete()}
        />
        <ErrorText>{error}</ErrorText>
      </View>
    </Screen>
  );
}
