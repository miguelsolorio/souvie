import { useHousehold } from "@mp/db";
import { Redirect, Stack } from "expo-router";
import { LoadingScreen, Screen } from "../../../src/components/Screen";
import { CREATE_HOUSEHOLD_ROUTE } from "../../../src/features/auth/routes";
import { AddRecipe } from "../../../src/features/recipes/AddRecipe";

/**
 * Add a recipe: from a link, pasted text, a photo, or by typing it in. Something shared in from
 * another app (a post's caption, a page link) lands here too.
 */
export default function NewRecipeScreen() {
  const household = useHousehold();

  if (household.isPending) return <LoadingScreen />;
  if (!household.data) return <Redirect href={CREATE_HOUSEHOLD_ROUTE} />;

  return (
    <Screen title="Add a recipe">
      <Stack.Screen options={{ title: "Add a recipe" }} />
      <AddRecipe />
    </Screen>
  );
}
