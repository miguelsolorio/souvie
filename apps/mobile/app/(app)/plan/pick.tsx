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
  initialTab,
  PICKER_TABS,
  type PickerTab,
  pickerRecipes,
  recipeWithId,
  TAB_EMPTY,
} from "../../../src/features/plan/pickerSearch";
import { newRecipeFromPickerRoute, planRoute } from "../../../src/features/plan/routes";
import { ServingsStepper } from "../../../src/features/plan/ServingsStepper";
import { useDefaultServings, usePlanActions } from "../../../src/features/plan/usePlanActions";
import { usePlanWeek } from "../../../src/features/plan/usePlanWeek";
import { formatServings, summaryLine } from "../../../src/features/recipes/format";
import { RecipeImage } from "../../../src/features/recipes/RecipeImage";

/**
 * The recipe picker, opened over the planner for `?date=&slot=`. Search the household's recipes,
 * or browse Recent and Favorites. Choosing one asks how many servings, then adds it to the slot.
 * With `&entry=` it swaps that meal's recipe instead and keeps its servings and notes.
 *
 * "Add a recipe" is always on screen. It opens the add-recipe screen with this picker's date,
 * slot and swap target as params, and saving there comes back here with `&added=<recipe id>`:
 * the new recipe goes first under All and, when adding, its servings sheet opens.
 */
export default function PickRecipeScreen() {
  const params = useLocalSearchParams<{
    date?: string;
    slot?: string;
    entry?: string;
    added?: string;
  }>();
  const slot = MealSlot.safeParse(params.slot);
  const date = params.date && isIsoDate(params.date) ? params.date : null;
  if (!date || !slot.success) return <Redirect href={planRoute()} />;
  return (
    <Picker
      date={date}
      slot={slot.data}
      entryId={params.entry ?? null}
      addedId={params.added ? params.added : null}
    />
  );
}

function Picker({
  date,
  slot,
  entryId,
  addedId,
}: {
  date: string;
  slot: MealSlot;
  entryId: string | null;
  addedId: string | null;
}) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const household = useHousehold();
  const householdId = household.data?.id;
  const week = usePlanWeek(weekStartFor(date));
  const actions = usePlanActions(householdId);
  const defaultServings = useDefaultServings();
  // The household's own recipes and the starter catalog, which every member may plan.
  const recipes = useRecipes(householdId, { includeCatalog: true });
  const recent = useRecentRecipeIds(householdId);
  const favorites = useFavoriteRecipeIds();
  // Keep the week's entries warm so a swap target is in the cache.
  useMealPlanEntries(week.plan?.id);

  // Null until the lists have loaded, so the first tab is chosen once, from real data.
  const [pickedTab, setPickedTab] = useState<PickerTab | null>(null);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<RecipeSummary | null>(null);
  const [servings, setServings] = useState(4);
  // The `added` recipe the picker already reacted to, so closing its sheet leaves it closed.
  const [handledAdded, setHandledAdded] = useState<string | null>(null);

  const swapTarget = entryId ? (week.entries.find((entry) => entry.id === entryId) ?? null) : null;
  const swapping = entryId !== null;
  const tab: PickerTab = pickedTab ?? "all";

  const shown = useMemo(
    () =>
      pickerRecipes({
        recipes: recipes.data ?? [],
        tab,
        query,
        recentIds: recent.data ?? [],
        favoriteIds: favorites.data ?? [],
        firstId: addedId,
      }),
    [recipes.data, tab, query, recent.data, favorites.data, addedId],
  );

  function offerAdd(recipe: RecipeSummary) {
    setServings(defaultServings(recipe.servings));
    setChosen(recipe);
  }

  // The two blocks below adjust state while rendering, which React allows when the update is
  // guarded by the state it sets. There is no effect, so no frame shows the wrong tab or no sheet.
  //
  // First load: open on Recent only if it has something to show, else on All.
  if (pickedTab === null && !household.isPending && !recipes.isPending && !recent.isLoading) {
    setPickedTab(addedId ? "all" : initialTab(recent.data ?? [], recipes.data ?? []));
  }
  // Back from the add-recipe screen: the new recipe goes first under All, and when adding (not
  // swapping) its servings sheet opens. A swap stays one tap on the recipe, not a surprise.
  const added =
    addedId && addedId !== handledAdded ? recipeWithId(recipes.data ?? [], addedId) : null;
  if (added) {
    setHandledAdded(added.id);
    setPickedTab("all");
    setQuery("");
    if (!swapping) offerAdd(added);
  }

  if (household.isPending || recipes.isPending || recent.isLoading) return <LoadingScreen />;
  if (!householdId) return <Redirect href={CREATE_HOUSEHOLD_ROUTE} />;

  const total = recipes.data?.length ?? 0;
  const searching = query.trim().length > 0;
  const tabEmpty = tab === "recent" ? TAB_EMPTY.recent : TAB_EMPTY.favorites;

  function choose(recipe: RecipeSummary) {
    if (swapping) {
      if (!swapTarget) return;
      actions.swapRecipe(swapTarget, recipe);
      router.back();
      return;
    }
    offerAdd(recipe);
  }

  function addNewRecipe() {
    router.push(newRecipeFromPickerRoute({ date, slot, entry: entryId ?? undefined }));
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
      <View className="mx-auto w-full max-w-2xl px-4 pt-4">
        <Button
          testID="picker-add-recipe"
          label="Add a recipe"
          variant="secondary"
          onPress={addNewRecipe}
        />
      </View>
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
                onChange={setPickedTab}
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
              title={tabEmpty.title}
              message={tabEmpty.message}
              action={{ label: "Show all recipes", onPress: () => setPickedTab("all") }}
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
