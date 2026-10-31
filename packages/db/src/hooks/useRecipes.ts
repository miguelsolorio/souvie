import type { Recipe } from "@mp/core";
import { useQuery } from "@tanstack/react-query";
import type { MpClient } from "../client";
import { useSupabase } from "../context";

/**
 * The columns the recipe list shows. The embedding and the full instructions stay on the server.
 * `visibility` and a null `household_id` both say "starter catalog recipe"; a screen can use
 * either to tell one apart from the household's own.
 */
export type RecipeSummary = Pick<
  Recipe,
  | "id"
  | "household_id"
  | "visibility"
  | "title"
  | "description"
  | "image_url"
  | "source_type"
  | "source_url"
  | "servings"
  | "prep_min"
  | "cook_min"
  | "tags"
  | "cuisine"
  | "created_at"
>;

const SUMMARY_COLUMNS =
  "id, household_id, visibility, title, description, image_url, source_type, source_url, servings, prep_min, cook_min, tags, cuisine, created_at";

export interface RecipeListOptions {
  /**
   * Also list the starter catalog (rows with `visibility = catalog` and no household), which every
   * member may read. Off by default: the Recipes tab shows the household's own recipes only.
   */
  includeCatalog?: boolean | undefined;
}

export const recipesQueryKey = (
  householdId: string | null | undefined,
  options: RecipeListOptions = {},
) =>
  options.includeCatalog
    ? (["recipes", householdId, "with-catalog"] as const)
    : (["recipes", householdId] as const);

/**
 * The household's recipes, newest first, without the soft-deleted ones. With `includeCatalog` the
 * starter catalog is listed too. Row Level Security limits the query to rows the caller may read;
 * the filters here are for the list, not for safety.
 */
export async function fetchRecipes(
  client: MpClient,
  householdId: string,
  options: RecipeListOptions = {},
): Promise<RecipeSummary[]> {
  const base = client.from("recipes").select(SUMMARY_COLUMNS);
  const scoped = options.includeCatalog
    ? base.or(`household_id.eq.${householdId},visibility.eq.catalog`)
    : base.eq("household_id", householdId);
  const { data, error } = await scoped
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as RecipeSummary[];
}

/**
 * What `useRecipes` runs, as plain options so a test can run it without React. The catalog is in
 * the list only when `includeCatalog` is exactly true; anything else, including no options, is
 * the household's own recipes.
 */
export function recipesQueryOptions(
  client: MpClient,
  householdId: string | null | undefined,
  options: RecipeListOptions = {},
) {
  const includeCatalog = options.includeCatalog === true;
  return {
    queryKey: recipesQueryKey(householdId, { includeCatalog }),
    enabled: Boolean(householdId),
    queryFn: () => {
      if (!householdId) return Promise.resolve([]);
      return fetchRecipes(client, householdId, { includeCatalog });
    },
  };
}

export function useRecipes(
  householdId: string | null | undefined,
  options: RecipeListOptions = {},
) {
  const client = useSupabase();
  return useQuery(recipesQueryOptions(client, householdId, options));
}
