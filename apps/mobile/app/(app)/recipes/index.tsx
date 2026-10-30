import { useHousehold, useRecipes } from "@mp/db";
import { Redirect, Stack, useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { FlatList, Pressable, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../../src/components/Button";
import { LoadingScreen } from "../../../src/components/Screen";
import { CREATE_HOUSEHOLD_ROUTE } from "../../../src/features/auth/routes";
import { filterRecipes, summaryLine } from "../../../src/features/recipes/format";
import { RecipeImage } from "../../../src/features/recipes/RecipeImage";

/** The household's recipes, newest first, with a search box. Deleted recipes are not listed. */
export default function RecipesScreen() {
  const router = useRouter();
  const household = useHousehold();
  const recipes = useRecipes(household.data?.id);
  const [query, setQuery] = useState("");
  const shown = useMemo(() => filterRecipes(recipes.data ?? [], query), [recipes.data, query]);

  if (household.isPending) return <LoadingScreen />;
  if (!household.data) return <Redirect href={CREATE_HOUSEHOLD_ROUTE} />;

  const total = recipes.data?.length ?? 0;

  return (
    <SafeAreaView className="flex-1 bg-white" edges={["bottom"]}>
      <Stack.Screen options={{ title: "Recipes" }} />
      <FlatList
        data={shown}
        keyExtractor={(item) => item.id}
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="mx-auto w-full max-w-md gap-3 px-6 py-6"
        refreshing={recipes.isRefetching}
        onRefresh={() => void recipes.refetch()}
        ListHeaderComponent={
          <View className="gap-4 pb-2">
            <Button
              testID="add-recipe"
              label="Add a recipe"
              onPress={() => router.push("/recipes/new")}
            />
            {total > 0 ? (
              <TextInput
                testID="recipe-search"
                value={query}
                onChangeText={setQuery}
                placeholder="Search recipes"
                placeholderTextColor="#9ca3af"
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel="Search recipes"
                className="min-h-12 rounded-xl border border-neutral-300 bg-white px-4 text-base text-neutral-900"
              />
            ) : null}
          </View>
        }
        ListEmptyComponent={
          recipes.isPending ? (
            <Text className="py-8 text-center text-base text-neutral-500">Loading recipes...</Text>
          ) : recipes.isError ? (
            <View className="gap-3 py-8">
              <Text accessibilityRole="alert" className="text-center text-base text-red-700">
                Could not load your recipes.
              </Text>
              <Button
                label="Try again"
                variant="secondary"
                onPress={() => void recipes.refetch()}
              />
            </View>
          ) : total === 0 ? (
            <View testID="recipes-empty" className="gap-2 py-8">
              <Text className="text-center text-lg font-semibold text-neutral-900">
                No recipes yet
              </Text>
              <Text className="text-center text-base text-neutral-600">
                Paste a link, paste the text, photograph a recipe card, or type one in. Sharing a
                post from another app works too.
              </Text>
            </View>
          ) : (
            <Text className="py-8 text-center text-base text-neutral-500">
              No recipe matches "{query.trim()}".
            </Text>
          )
        }
        renderItem={({ item }) => {
          const line = summaryLine(item);
          return (
            <Pressable
              testID={`recipe-${item.id}`}
              accessibilityRole="button"
              accessibilityLabel={`${item.title}${line ? `, ${line}` : ""}`}
              onPress={() => router.push(`/recipes/${item.id}`)}
              className="flex-row items-center gap-4 rounded-xl border border-neutral-200 bg-white p-3"
            >
              <RecipeImage imageUrl={item.image_url} title={item.title} width={64} height={64} />
              <View className="flex-1 gap-1">
                <Text className="text-base font-semibold text-neutral-900" numberOfLines={2}>
                  {item.title}
                </Text>
                {line ? (
                  <Text className="text-sm text-neutral-600" numberOfLines={1}>
                    {line}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          );
        }}
      />
    </SafeAreaView>
  );
}
