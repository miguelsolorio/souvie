import {
  defaultServings,
  type MealEntryStatus,
  type MealPlan,
  type MealPlanEntryPatch,
  type MealSlot,
  nextPosition,
  type ProfilePreferences,
} from "@mp/core";
import {
  newId,
  type PlanEntry,
  type PlannedRecipe,
  planErrorMessage,
  type RecipeSummary,
  useDeleteEntry,
  useProfile,
  useUpsertEntry,
} from "@mp/db";
import { useCallback, useMemo } from "react";
import { showPlanNotice } from "./notice";
import "./ids";
import { swapPatch } from "./swap";

/** The slice of a recipe an entry shows, from the row the recipe list already holds. */
export function toPlannedRecipe(recipe: RecipeSummary): PlannedRecipe {
  return {
    id: recipe.id,
    title: recipe.title,
    image_url: recipe.image_url,
    servings: recipe.servings,
    prep_min: recipe.prep_min,
    cook_min: recipe.cook_min,
    deleted_at: null,
  };
}

export interface AddRecipeArgs {
  /** The week's plan, or null/undefined when it does not exist yet (it is created with the entry). */
  plan: MealPlan | null | undefined;
  date: string;
  slot: MealSlot;
  recipe: RecipeSummary;
  servings: number;
  /** The week's entries, to put the new one at the end of its slot. */
  entries: readonly PlanEntry[];
  why?: string | null | undefined;
}

/**
 * Everything a planner screen does to an entry, as plain calls. Each call updates the screen at
 * once and saves in the background; a save that fails for good puts the screen back and shows a
 * one-line notice (the screen that started it may be gone by then, like the picker).
 */
export function usePlanActions(householdId: string | null | undefined) {
  const upsert = useUpsertEntry((error) =>
    showPlanNotice(`That change was not saved. ${planErrorMessage(error)}`),
  );
  const remove = useDeleteEntry((error) =>
    showPlanNotice(`That meal was not removed. ${planErrorMessage(error)}`),
  );
  const upsertMutate = upsert.mutate;
  const removeMutate = remove.mutate;

  const addRecipe = useCallback(
    (args: AddRecipeArgs): string | null => {
      if (!householdId) return null;
      const id = newId();
      upsertMutate({
        mode: "add",
        id,
        householdId,
        // A week with no plan gets one now, with the first entry, never when it was only viewed.
        planId: args.plan?.id ?? newId(),
        planIsNew: !args.plan,
        entry: {
          date: args.date,
          slot: args.slot,
          recipe_id: args.recipe.id,
          servings: args.servings,
          position: nextPosition(args.entries, args.date, args.slot),
          why: args.why?.trim() ? args.why.trim() : null,
        },
        recipe: toPlannedRecipe(args.recipe),
      });
      return id;
    },
    [householdId, upsertMutate],
  );

  const edit = useCallback(
    (entry: PlanEntry, patch: MealPlanEntryPatch, recipe?: PlannedRecipe | null) => {
      if (!householdId) return;
      upsertMutate({
        mode: "edit",
        id: entry.id,
        householdId,
        planId: entry.plan_id,
        patch,
        ...(recipe !== undefined ? { recipe } : {}),
      });
    },
    [householdId, upsertMutate],
  );

  return useMemo(
    () => ({
      addRecipe,
      setServings: (entry: PlanEntry, servings: number) => edit(entry, { servings }),
      setNotes: (entry: PlanEntry, notes: string | null) => {
        const clean = notes?.trim() ? notes.trim() : null;
        if (clean !== entry.notes) edit(entry, { notes: clean });
      },
      /** Cooked and skipped write their feedback signal in the database, in the same transaction. */
      setStatus: (entry: PlanEntry, status: MealEntryStatus) => {
        if (status !== entry.status) edit(entry, { status });
      },
      /**
       * Swaps the recipe and keeps everything else about the entry, servings and notes included.
       * `why` is the suggestion's one-line reason, written with the swap; leave it out for a
       * recipe a person picked and the entry's reason is cleared (see swap.ts).
       */
      swapRecipe: (
        entry: PlanEntry,
        recipe: RecipeSummary,
        options: { why?: string | null | undefined } = {},
      ) => {
        edit(entry, swapPatch(recipe.id, options.why), toPlannedRecipe(recipe));
      },
      moveEntry: (
        entry: PlanEntry,
        target: { date: string; slot: MealSlot },
        entries: readonly PlanEntry[],
      ) => {
        if (target.date === entry.date && target.slot === entry.slot) return;
        edit(entry, {
          date: target.date,
          slot: target.slot,
          position: nextPosition(
            entries.filter((other) => other.id !== entry.id),
            target.date,
            target.slot,
          ),
        });
      },
      deleteEntry: (entry: PlanEntry) => {
        if (!householdId) return;
        removeMutate({ id: entry.id, householdId, planId: entry.plan_id });
      },
    }),
    [addRecipe, edit, householdId, removeMutate],
  );
}

/** Servings to start a recipe with: the person's own portions, their household size, the recipe. */
export function useDefaultServings(): (recipeServings: number | null | undefined) => number {
  const profile = useProfile();
  const preferences = profile.data?.preferences as ProfilePreferences | undefined;
  return useCallback(
    (recipeServings) => defaultServings({ preferences: preferences ?? null, recipeServings }),
    [preferences],
  );
}
