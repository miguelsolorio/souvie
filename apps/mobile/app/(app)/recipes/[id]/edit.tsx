import { recipeErrorMessage, useRecipe, useUpdateRecipe } from "@mp/db";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { Text } from "react-native";
import { Button } from "../../../../src/components/Button";
import { LoadingScreen, Screen } from "../../../../src/components/Screen";
import {
  draftFromRecipe,
  existingLines,
  formFromDraft,
} from "../../../../src/features/recipes/draft";
import { RecipeForm } from "../../../../src/features/recipes/RecipeForm";

/** Edit a recipe. Ingredient lines left alone keep what the parser already worked out. */
export default function EditRecipeScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const recipe = useRecipe(id);
  const update = useUpdateRecipe(id);
  const [error, setError] = useState<string | null>(null);

  if (recipe.isPending) return <LoadingScreen />;

  if (recipe.isError || !recipe.data) {
    return (
      <Screen title="Edit recipe">
        <Stack.Screen options={{ title: "Edit recipe" }} />
        <Text accessibilityRole="alert" className="text-base text-red-700">
          {recipe.isError
            ? "Could not load this recipe."
            : "This recipe was deleted, or you do not have access to it."}
        </Text>
        <Button label="Back to recipes" onPress={() => router.replace("/recipes")} />
      </Screen>
    );
  }

  const current = recipe.data;

  return (
    <Screen title="Edit recipe">
      <Stack.Screen options={{ title: "Edit recipe" }} />
      <RecipeForm
        initial={formFromDraft(draftFromRecipe(current))}
        existing={existingLines(current)}
        submitLabel="Save changes"
        submitting={update.isPending}
        error={error}
        onCancel={() => router.back()}
        onSubmit={(draft) => {
          setError(null);
          update.mutate(draft, {
            onSuccess: () => router.back(),
            onError: (cause) => setError(recipeErrorMessage(cause)),
          });
        }}
      />
    </Screen>
  );
}
