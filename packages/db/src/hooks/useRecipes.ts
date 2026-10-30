import type { Recipe } from "@mp/core";
import { useQuery } from "@tanstack/react-query";
import type { MpClient } from "../client";
import { useSupabase } from "../context";

/** The columns the recipe list shows. The embedding and the full instructions stay on the server. */
export type RecipeSummary = Pick<
  Recipe,
  | "id"
  | "household_id"
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
  "id, household_id, title, description, image_url, source_type, source_url, servings, prep_min, cook_min, tags, cuisine, created_at";

export const recipesQueryKey = (householdId: string | null | undefined) =>
  ["recipes", householdId] as const;

/**
 * The household's recipes, newest first, without the soft-deleted ones. Row Level Security limits
 * the query to households the caller belongs to; the filter here is for the list, not for safety.
 */
export async function fetchRecipes(
  client: MpClient,
  householdId: string,
): Promise<RecipeSummary[]> {
  const { data, error } = await client
    .from("recipes")
    .select(SUMMARY_COLUMNS)
    .eq("household_id", householdId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as RecipeSummary[];
}

export function useRecipes(householdId: string | null | undefined) {
  const client = useSupabase();

  return useQuery({
    queryKey: recipesQueryKey(householdId),
    enabled: Boolean(householdId),
    queryFn: () => {
      if (!householdId) return Promise.resolve([]);
      return fetchRecipes(client, householdId);
    },
  });
}
