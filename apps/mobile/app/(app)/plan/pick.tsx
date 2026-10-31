import { isIsoDate, MealSlot, weekStartFor } from "@mp/core";
import {
  type RecipeSummary,
  useFavoriteRecipeIds,
  useHousehold,
  useMealPlanEntries,
  useRecentRecipeIds,
  useRecipes,
} from "@mp/db";
import { EmptyState, SegmentedControl, Sheet } from "@mp/ui/primitives";
import { Redirect, Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { FlatList, Pressable, Text, TextInput, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "../../../src/components/Button";
import { LoadingScreen } from "../../../src/components/Screen";
import { CREATE_HOUSEHOLD_ROUTE } from "../../../src/features/auth/routes";
import { dayName, SLOT_LABELS, slotTitle } from "../../../src/features/plan/format";
import {
  PICKER_TABS,
  type PickerTab,
  pickerRecipes,
} from "../../../src/features/plan/pickerSearch";
import { planRoute } from "../../../src/features/plan/routes";
import { ServingsStepper } from "../../../src/features/plan/ServingsStepper";
import { useDefaultServings, usePlanActions } from "../../../src/features/plan/usePlanActions";
import { usePlanWeek } from "../../../src/features/plan/usePlanWeek";
import { formatServings, summaryLine } from "../../../src/features/recipes/format";
import { RecipeImage } from "../../../src/features/recipes/RecipeImage";

/**
 * The recipe picker, opened over the planner for `?date=&slot=`. Search the household's recipes,
 * or browse Recent and Favorites. Choosing one asks how many servings, then adds it to the slot.
 * With `&entry=` it swaps that meal's recipe instead and keeps its servings and notes.
 */
export default function PickRecipeScreen() {
  const params = useLocalSearchParams<{ date?: string; slot?: string; entry?: string }>();
  const slot = MealSlot.safeParse(params.slot);
  const date = params.date && isIsoDate(params.date) ? params.date : null;
  if (!date || !slot.success) return <Redirect href={planRoute()} />;
  return <Picker date={date} slot={slot.data} entryId={params.entry ?? null} />;
}

function Picker({ date, slot, entryId }: { date: string; slot: MealSlot; entryId: string | null }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const household = useHousehold();
  const householdId = household.data?.id;
  const week = usePlanWeek(weekStartFor(date));
  const actions = usePlanActions(householdId);
  const defaultServings = useDefaultServings();
  const recipes = useRecipes(householdId);
  const recent = useRecentRecipeIds(householdId);
  const favorites = useFavoriteRecipeIds();
  // Keep the week's entries warm so a swap target is in the cache.
  useMealPlanEntries(week.plan?.id);

  const [tab, setTab] = useState<PickerTab>("recent");
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<RecipeSummary | null>(null);
  const [servings, setServings] = useState(4);

  const swapTarget = entryId ? (week.entries.find((entry) => entry.id === entryId) ?? null) : null;
  const swapping = entryId !== null;

  const shown = useMemo(
    () =>
      pickerRecipes({
        recipes: recipes.data ?? [],
        tab,
        query,
        recentIds: recent.data ?? [],
        favoriteIds: favorites.data ?? [],
      }),
    [recipes.data, tab, query, recent.data, favorites.data],
  );

  if (household.isPending || recipes.isPending) return <LoadingScreen />;
  if (!householdId) return <Redirect href={CREATE_HOUSEHOLD_ROUTE} />;

  const total = recipes.data?.length ?? 0;
  const searching = query.trim().length > 0;

  function choose(recipe: RecipeSummary) {
    if (swapping) {
      if (!swapTarget) return;
      actions.swapRecipe(swapTarget, recipe);
      router.back();
      return;
    }
    setServings(defaultServings(recipe.servings));
    setChosen(recipe);
  }

  function confirmAdd() {
    if (!chosen) return;
    actions.addRecipe({
      plan: week.plan,
      date,
      slot,
      recipe: chosen,
      servings,
      entries: week.entries,
    });
    setChosen(null);
    router.back();
  }

  return (
    <SafeAreaView className="flex-1 bg-white" edges={["bottom"]}>
      <Stack.Screen
        options={{
          title: swapping ? "Swap recipe" : `Add to ${slotTitle(date, slot)}`,
          presentation: "modal",
        }}
      />
      <FlatList
        data={shown}
        keyExtractor={(item) => item.id}
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="mx-auto w-full max-w-2xl gap-3 px-4 py-4"
        testID="picker-list"
        ListHeaderComponent={
          <View className="gap-3 pb-2">
            {swapping && !swapTarget ? (
              <Text accessibilityRole="alert" className="text-sm text-red-700">
                That meal is no longer in the plan.
              </Text>
            ) : null}
            {swapping && swapTarget ? (
              <Text className="text-sm text-neutral-600">
                Replacing {swapTarget.recipe?.title ?? "this recipe"} on {slotTitle(date, slot)}.
                Servings and notes stay.
              </Text>
            ) : null}
            <TextInput
              testID="picker-search"
              value={query}
              onChangeText={setQuery}
              placeholder="Search your recipes"
              placeholderTextColor="#9ca3af"
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
              accessibilityLabel="Search your recipes"
              className="min-h-12 rounded-xl border border-neutral-300 bg-white px-4 text-base text-neutral-900"
            />
            {searching ? (
              <Text testID="picker-count" className="text-sm text-neutral-600">
                {shown.length === 1 ? "1 recipe" : `${shown.length} recipes`}
              </Text>
            ) : (
              <SegmentedControl
                testID="picker-tabs"
                label="Recipe list"
                value={tab}
                onChange={setTab}
                options={PICKER_TABS.map((t) => ({
                  value: t.value,
                  label: t.label,
                  testID: `picker-tab-${t.value}`,
                }))}
              />
            )}
          </View>
        }
        ListEmptyComponent={
          recipes.isError ? (
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
            <EmptyState
              testID="picker-no-recipes"
              icon="📖"
              title="No recipes yet"
              message="Add a recipe first, then plan it here."
              action={{
                label: "Add a recipe",
                onPress: () => router.replace("/recipes/new"),
              }}
            />
          ) : searching ? (
            <EmptyState
              testID="picker-no-match"
              title={`No recipe matches "${query.trim()}"`}
              message="Check the spelling, or try a shorter search."
            />
          ) : (
            <EmptyState
              testID="picker-tab-empty"
              title={tab === "recent" ? "Nothing planned yet" : "No favorites yet"}
              message={
                tab === "recent"
                  ? "Recipes you plan show up here. Try All to browse everything."
                  : "Thumb a recipe up on its meal to find it here."
              }
              action={{ label: "Show all recipes", onPress: () => setTab("all") }}
            />
          )
        }
        renderItem={({ item }) => (
          <Pressable
            testID={`pick-${item.id}`}
            accessibilityRole="button"
            accessibilityLabel={`${item.title}, ${summaryLine(item) || "recipe"}`}
            onPress={() => choose(item)}
            className="min-h-16 flex-row items-center gap-4 rounded-xl border border-neutral-200 bg-white p-3"
          >
            <RecipeImage imageUrl={item.image_url} title={item.title} width={56} height={56} />
            <View className="flex-1 gap-0.5">
              <Text className="text-base font-semibold text-neutral-900" numberOfLines={2}>
                {item.title}
              </Text>
              <Text className="text-sm text-neutral-600" numberOfLines={1}>
                {summaryLine(item)}
              </Text>
            </View>
          </Pressable>
        )}
      />

      <Sheet
        visible={chosen !== null}
        onClose={() => setChosen(null)}
        title={chosen ? `Add ${chosen.title}` : "Add recipe"}
        bottomInset={insets.bottom}
        testID="pick-confirm"
      >
        <Text className="text-base text-neutral-700">
          {`${SLOT_LABELS[slot]} on ${dayName(date)}`}
          {chosen?.servings ? `. The recipe makes ${formatServings(chosen.servings)}.` : "."}
        </Text>
        <View className="flex-row items-center justify-between gap-4">
          <Text className="text-base font-semibold text-neutral-900">Servings</Text>
          <ServingsStepper value={servings} onChange={setServings} testID="pick-servings" />
        </View>
        <Button testID="pick-add" label={`Add to ${slotTitle(date, slot)}`} onPress={confirmAdd} />
      </Sheet>
    </SafeAreaView>
  );
}
