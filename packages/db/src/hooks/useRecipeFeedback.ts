import type { FeedbackSignal, RecipeFeedback, ThumbSignal } from "@mp/core";
import {
  type MutationOptions,
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { MpClient } from "../client";
import { useSupabase } from "../context";
import { newId } from "../ids";
import {
  favoriteRecipesKey,
  planRetryDelay,
  recipeFeedbackKey,
  shouldRetryPlanWrite,
  toPlanError,
} from "../planning";
import { useSession } from "./useSession";

// What the planner writes to recipe_feedback, and what it reads back.
//
// The planner itself writes `saved` (a recipe was added or swapped in), `cooked` and `skipped`
// through a database trigger, in the same transaction as the entry change. This file handles the
// two signals a person gives by hand: `like` and `dislike`, the thumbs on the entry sheet. A thumb
// is a state, not an event: setting one replaces the person's previous thumb for that recipe.

const FEEDBACK_COLUMNS = "id, household_id, user_id, recipe_id, signal, rating, created_at";

/** The most recent thumb in a list of the caller's feedback rows, or null for none. */
export function currentThumb(
  rows: ReadonlyArray<Pick<RecipeFeedback, "signal" | "created_at">> | undefined,
): ThumbSignal | null {
  let best: { signal: ThumbSignal; at: string } | null = null;
  for (const row of rows ?? []) {
    if (row.signal !== "like" && row.signal !== "dislike") continue;
    if (!best || row.created_at > best.at) best = { signal: row.signal, at: row.created_at };
  }
  return best?.signal ?? null;
}

/** Recipe ids whose latest thumb from the caller is a like, newest first. */
export function favoriteIds(
  rows: ReadonlyArray<Pick<RecipeFeedback, "recipe_id" | "signal" | "created_at">>,
): string[] {
  const latest = new Map<string, { signal: FeedbackSignal; at: string }>();
  for (const row of rows) {
    if (row.signal !== "like" && row.signal !== "dislike") continue;
    const seen = latest.get(row.recipe_id);
    if (!seen || row.created_at > seen.at) {
      latest.set(row.recipe_id, { signal: row.signal, at: row.created_at });
    }
  }
  return [...latest.entries()]
    .filter(([, value]) => value.signal === "like")
    .sort((a, b) => b[1].at.localeCompare(a[1].at))
    .map(([recipeId]) => recipeId);
}

/** The caller's own feedback rows for one recipe, newest first. */
export async function fetchRecipeFeedback(
  client: MpClient,
  userId: string,
  recipeId: string,
): Promise<RecipeFeedback[]> {
  const { data, error, status } = await client
    .from("recipe_feedback")
    .select(FEEDBACK_COLUMNS)
    .eq("user_id", userId)
    .eq("recipe_id", recipeId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw toPlanError(error, status);
  return (data ?? []) as unknown as RecipeFeedback[];
}

/** The caller's like and dislike rows, newest first, to work out which recipes they favor. */
export async function fetchFavoriteRecipeIds(client: MpClient, userId: string): Promise<string[]> {
  const { data, error, status } = await client
    .from("recipe_feedback")
    .select("recipe_id, signal, created_at")
    .eq("user_id", userId)
    .in("signal", ["like", "dislike"])
    .order("created_at", { ascending: false })
    .limit(1000);
  if (error) throw toPlanError(error, status);
  return favoriteIds((data ?? []) as unknown as RecipeFeedback[]);
}

export interface SetThumbInput {
  householdId: string;
  recipeId: string;
  /** like, dislike, or null to take the thumb back. */
  thumb: ThumbSignal | null;
}

/**
 * Sets the caller's thumb for a recipe. The new row goes in first, then the older thumb rows are
 * removed, so a failure between the two leaves a thumb behind rather than none. The new row has an
 * id the call picked once, so a retry repeats it harmlessly.
 */
export async function setThumb(
  client: MpClient,
  userId: string,
  input: SetThumbInput,
  id: string = newId(),
): Promise<void> {
  if (input.thumb) {
    const { error, status } = await client
      .from("recipe_feedback")
      .upsert(
        { id, household_id: input.householdId, recipe_id: input.recipeId, signal: input.thumb },
        { onConflict: "id", ignoreDuplicates: true },
      );
    if (error) throw toPlanError(error, status);
  }
  let remove = client
    .from("recipe_feedback")
    .delete()
    .eq("user_id", userId)
    .eq("recipe_id", input.recipeId)
    .in("signal", ["like", "dislike"]);
  if (input.thumb) remove = remove.neq("id", id);
  const { error, status } = await remove;
  if (error) throw toPlanError(error, status);
}

/** The caller's feedback for one recipe. `currentThumb(data)` is the thumb to show. */
export function useRecipeFeedback(recipeId: string | null | undefined) {
  const client = useSupabase();
  const { user } = useSession();
  const userId = user?.id;

  return useQuery({
    queryKey: recipeFeedbackKey(userId, recipeId),
    enabled: Boolean(userId && recipeId),
    queryFn: () => {
      if (!userId || !recipeId) return Promise.resolve([]);
      return fetchRecipeFeedback(client, userId, recipeId);
    },
  });
}

/** Recipe ids the caller has thumbed up (their latest thumb for the recipe is a like). */
export function useFavoriteRecipeIds() {
  const client = useSupabase();
  const { user } = useSession();
  const userId = user?.id;

  return useQuery({
    queryKey: favoriteRecipesKey(userId),
    enabled: Boolean(userId),
    queryFn: () => {
      if (!userId) return Promise.resolve([]);
      return fetchFavoriteRecipeIds(client, userId);
    },
  });
}

interface ThumbContext {
  previous: RecipeFeedback[] | undefined;
}

/** The mutation behind useSetThumb, as plain options so tests can run it without React. */
export function setThumbOptions(
  client: MpClient,
  queryClient: QueryClient,
  userId: string | undefined,
): MutationOptions<void, Error, SetThumbInput, ThumbContext> {
  return {
    retry: shouldRetryPlanWrite,
    retryDelay: planRetryDelay,

    mutationFn: (input) => {
      if (!userId) throw new Error("not_authenticated");
      return setThumb(client, userId, input);
    },

    onMutate: async (input) => {
      const key = recipeFeedbackKey(userId, input.recipeId);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<RecipeFeedback[]>(key);
      if (userId) {
        const without = (previous ?? []).filter(
          (row) => row.signal !== "like" && row.signal !== "dislike",
        );
        const now = new Date().toISOString();
        queryClient.setQueryData<RecipeFeedback[]>(
          key,
          input.thumb
            ? [
                {
                  id: newId(),
                  household_id: input.householdId,
                  user_id: userId,
                  recipe_id: input.recipeId,
                  signal: input.thumb,
                  rating: null,
                  created_at: now,
                },
                ...without,
              ]
            : without,
        );
      }
      return { previous };
    },

    onError: (_error, input, context) => {
      if (context?.previous === undefined) return;
      queryClient.setQueryData(recipeFeedbackKey(userId, input.recipeId), context.previous);
    },

    onSettled: async (_data, _error, input) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: recipeFeedbackKey(userId, input.recipeId) }),
        queryClient.invalidateQueries({ queryKey: favoriteRecipesKey(userId) }),
      ]);
    },
  };
}

/** Thumbs a recipe up or down, or takes the thumb back. Optimistic; rolls back on failure. */
export function useSetThumb() {
  const client = useSupabase();
  const queryClient = useQueryClient();
  const { user } = useSession();
  return useMutation(setThumbOptions(client, queryClient, user?.id));
}
