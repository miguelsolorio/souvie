// Which recipes the picker shows (WS04). Pure, so it is unit-tested and timed.
//
// The picker filters the household's cached recipe list on the device. That is why a search
// answers in a millisecond or two, works offline, and needs no server round trip per keystroke.
import { recipeSourceDomain } from "@mp/core";
import type { RecipeSummary } from "@mp/db";

export type PickerTab = "recent" | "favorites" | "all";

export const PICKER_TABS: ReadonlyArray<{ value: PickerTab; label: string }> = [
  { value: "recent", label: "Recent" },
  { value: "favorites", label: "Favorites" },
  { value: "all", label: "All" },
];

/**
 * What an empty Recent or Favorites tab says. Both sit next to a "Show all recipes" action. A tab
 * can be empty while the household has recipes, so the words say what the tab is, not that the
 * household has nothing.
 */
export const TAB_EMPTY = {
  recent: {
    title: "Nothing planned yet",
    message: "Recipes you have planned before show up here.",
  },
  favorites: {
    title: "No favorites yet",
    message: "Thumb a recipe up on its meal to find it here.",
  },
} as const;

function words(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

/**
 * Recipes matching every word of the query, best first: a title that starts with the first word,
 * then a title that contains every word, then a match on tags, cuisine, or source. Ties keep the
 * list's own order. An empty query returns everything, in order.
 */
export function searchRecipes(recipes: readonly RecipeSummary[], query: string): RecipeSummary[] {
  const terms = words(query);
  if (terms.length === 0) return [...recipes];

  const scored: Array<{ recipe: RecipeSummary; score: number; index: number }> = [];
  recipes.forEach((recipe, index) => {
    const title = recipe.title.toLowerCase();
    const other = [
      recipe.cuisine ?? "",
      ...recipe.tags,
      recipeSourceDomain(recipe.source_url) ?? "",
    ]
      .join(" ")
      .toLowerCase();
    const inTitle = terms.every((term) => title.includes(term));
    const inAny = terms.every((term) => title.includes(term) || other.includes(term));
    if (!inAny) return;
    const first = terms[0] ?? "";
    const score = inTitle ? (title.startsWith(first) ? 0 : 1) : 2;
    scored.push({ recipe, score, index });
  });
  return scored.sort((a, b) => a.score - b.score || a.index - b.index).map((s) => s.recipe);
}

function inOrder(recipes: readonly RecipeSummary[], ids: readonly string[]): RecipeSummary[] {
  const byId = new Map(recipes.map((recipe) => [recipe.id, recipe]));
  return ids.flatMap((id) => {
    const recipe = byId.get(id);
    return recipe ? [recipe] : [];
  });
}

/** Recipes A to Z by title, so "All" is easy to scan. */
export function byTitle(recipes: readonly RecipeSummary[]): RecipeSummary[] {
  return [...recipes].sort((a, b) =>
    a.title.localeCompare(b.title, "en", { sensitivity: "base", numeric: true }),
  );
}

/**
 * The tab the picker opens on: Recent when the household has planned a recipe it still has, so
 * the usual repeat meals are one tap away; otherwise All, since an empty Recent would be the
 * first thing a person sees. Pass `recipes` to count only recent ids that are still listed
 * (a recipe deleted since it was planned does not fill Recent). The tabs stay switchable.
 */
export function initialTab(
  recentIds: readonly string[],
  recipes?: readonly Pick<RecipeSummary, "id">[],
): PickerTab {
  if (!recipes) return recentIds.length > 0 ? "recent" : "all";
  const listed = new Set(recipes.map((recipe) => recipe.id));
  return recentIds.some((id) => listed.has(id)) ? "recent" : "all";
}

/** The recipe with this id, or null for no id or an id the list does not hold (yet). */
export function recipeWithId(
  recipes: readonly RecipeSummary[],
  id: string | null | undefined,
): RecipeSummary | null {
  if (!id) return null;
  return recipes.find((recipe) => recipe.id === id) ?? null;
}

/** The list with the recipe of this id moved to the front; unchanged when it is not in it. */
function withFirst(recipes: RecipeSummary[], id: string | null | undefined): RecipeSummary[] {
  const first = recipeWithId(recipes, id);
  if (!first) return recipes;
  return [first, ...recipes.filter((recipe) => recipe.id !== first.id)];
}

/**
 * The list for the current tab and search box. A search looks through every recipe, whatever the
 * tab, because typing means "I know what I want". Recent and Favorites skip recipes that are
 * gone from the household's list (deleted since). `firstId` is a recipe the person just added:
 * under All, with no search, it goes first so it is the first thing they see.
 */
export function pickerRecipes(args: {
  recipes: readonly RecipeSummary[];
  tab: PickerTab;
  query: string;
  recentIds: readonly string[];
  favoriteIds: readonly string[];
  firstId?: string | null | undefined;
}): RecipeSummary[] {
  const { recipes, tab, query, recentIds, favoriteIds, firstId } = args;
  if (words(query).length > 0) return searchRecipes(byTitle(recipes), query);
  if (tab === "recent") return inOrder(recipes, recentIds);
  if (tab === "favorites") return inOrder(recipes, favoriteIds);
  return withFirst(byTitle(recipes), firstId);
}
