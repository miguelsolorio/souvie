import { type MealPlan, MealPlanEntryInput, MealPlanEntryPatch, weekStartFor } from "@mp/core";
import {
  type MutationOptions,
  type QueryClient,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type { MpClient } from "../client";
import { useSupabase } from "../context";
import {
  ensureMealPlan,
  findCachedEntry,
  insertEntry,
  invalidateMealPlan,
  inversePatch,
  mealPlanEntriesKey,
  mealPlanKey,
  type PlanEntry,
  PlanError,
  type PlannedRecipe,
  patchEntry,
  planRetryDelay,
  shouldRetryPlanWrite,
  withEntry,
  withoutEntry,
  withPatch,
} from "../planning";

/** Add a recipe to a slot. The caller picks both ids, so a retry sends the same ones. */
export interface AddEntryInput {
  mode: "add";
  /** The new entry's id (a UUID the caller made). */
  id: string;
  householdId: string;
  /**
   * The week's plan id. When the week has no plan yet, pass a fresh UUID and set `planIsNew`:
   * the plan row is created now, on the first entry, never when the week is only viewed.
   */
  planId: string;
  planIsNew?: boolean;
  entry: MealPlanEntryInput;
  /** The recipe's title and picture, for the optimistic row. The server's copy replaces it. */
  recipe?: PlannedRecipe | null;
}

/** Change columns of an entry that exists: servings, status, notes, position, or swap and move. */
export interface EditEntryInput {
  mode: "edit";
  id: string;
  householdId: string;
  planId: string;
  patch: MealPlanEntryPatch;
  /** The new recipe's title and picture, when the patch swaps `recipe_id`. */
  recipe?: PlannedRecipe | null;
}

export type UpsertEntryInput = AddEntryInput | EditEntryInput;

export interface UpsertEntryResult {
  /** The plan the entry landed in. Differs from the input's when another device made the week first. */
  planId: string;
  /** The plan row, when this call created or looked it up. */
  plan: MealPlan | null;
}

interface UpsertContext {
  /** The week the change touches, or null when the cache could not say (an edit it never held). */
  weekStart: string | null;
  /** Puts the cache back the way it was, touching only what this call changed. */
  undo: () => void;
}

function validate(input: UpsertEntryInput): void {
  try {
    if (input.mode === "add") MealPlanEntryInput.parse(input.entry);
    else MealPlanEntryPatch.parse(input.patch);
  } catch (error) {
    throw new PlanError("invalid", error instanceof Error ? error.message : "invalid");
  }
}

function optimisticEntry(input: AddEntryInput): PlanEntry {
  const entry = MealPlanEntryInput.parse(input.entry);
  const now = new Date().toISOString();
  return {
    id: input.id,
    plan_id: input.planId,
    household_id: input.householdId,
    date: entry.date,
    slot: entry.slot,
    recipe_id: entry.recipe_id,
    servings: entry.servings,
    status: entry.status,
    notes: entry.notes,
    position: entry.position,
    created_at: now,
    updated_at: now,
    recipe: input.recipe ?? null,
  };
}

/**
 * The mutation behind useUpsertEntry, as plain options so tests can run it without React.
 *
 * Optimistic: onMutate edits the cached plan and entries at once, so the UI answers on the tap.
 * Rollback: onError undoes exactly that edit (not a whole-cache snapshot, which would also
 * discard a second tap that landed meanwhile). Settled: the plan and entries are marked stale and
 * refetched, so the cache converges on the database whatever happened.
 *
 * Offline: a dropped connection is retried with backoff for about a minute (the entry id and the
 * ON CONFLICT DO NOTHING insert make that safe); on the web, TanStack pauses the mutation while
 * the browser reports offline and resumes it on reconnect.
 */
export function upsertEntryOptions(
  client: MpClient,
  queryClient: QueryClient,
): MutationOptions<UpsertEntryResult, Error, UpsertEntryInput, UpsertContext> {
  return {
    retry: shouldRetryPlanWrite,
    retryDelay: planRetryDelay,

    mutationFn: async (input) => {
      validate(input);
      if (input.mode === "edit") {
        await patchEntry(client, input.id, input.patch);
        return { planId: input.planId, plan: null };
      }
      let planId = input.planId;
      let plan: MealPlan | null = null;
      if (input.planIsNew) {
        plan = await ensureMealPlan(client, {
          householdId: input.householdId,
          weekStart: weekStartFor(input.entry.date),
          planId,
        });
        planId = plan.id;
      }
      await insertEntry(client, {
        id: input.id,
        planId,
        householdId: input.householdId,
        entry: input.entry,
      });
      return { planId, plan };
    },

    onMutate: async (input) => {
      validate(input);
      const { householdId } = input;
      await queryClient.cancelQueries({ queryKey: ["meal-plan", householdId] });
      const entriesKey = mealPlanEntriesKey(householdId, input.planId);

      if (input.mode === "add") {
        const weekStart = weekStartFor(input.entry.date);
        const planKey = mealPlanKey(householdId, weekStart);
        const hadPlan = queryClient.getQueryData<MealPlan | null>(planKey);
        const added = optimisticEntry(input);

        // A week with no plan yet shows the new entry under the plan id we are about to create.
        if (!hadPlan) {
          const now = new Date().toISOString();
          const optimisticPlan: MealPlan = {
            id: input.planId,
            household_id: householdId,
            week_start: weekStart,
            created_at: now,
            updated_at: now,
          };
          queryClient.setQueryData<MealPlan | null>(planKey, optimisticPlan);
        }
        queryClient.setQueryData<PlanEntry[]>(entriesKey, (old) => withEntry(old, added));

        return {
          weekStart,
          undo: () => {
            queryClient.setQueryData<PlanEntry[]>(entriesKey, (old) => withoutEntry(old, input.id));
            if (!hadPlan) {
              // Nothing was cached, or the cache knew the week had no plan: put that back.
              if (hadPlan === undefined)
                queryClient.removeQueries({ queryKey: planKey, exact: true });
              else queryClient.setQueryData<MealPlan | null>(planKey, hadPlan);
            }
          },
        };
      }

      const before = findCachedEntry(queryClient, householdId, input.id);
      queryClient.setQueryData<PlanEntry[]>(entriesKey, (old) => {
        const patched = withPatch(old, input.id, input.patch);
        if (input.recipe === undefined || input.patch.recipe_id === undefined) return patched;
        return patched.map((entry) =>
          entry.id === input.id ? { ...entry, recipe: input.recipe ?? null } : entry,
        );
      });
      const patchedDate = input.patch.date;
      const weekDate = patchedDate ?? before?.date;
      return {
        weekStart: weekDate ? weekStartFor(weekDate) : null,
        undo: () => {
          if (!before) return;
          queryClient.setQueryData<PlanEntry[]>(entriesKey, (old) => {
            const restored = withPatch(old, input.id, inversePatch(before, input.patch));
            if (input.patch.recipe_id === undefined) return restored;
            return restored.map((entry) =>
              entry.id === input.id ? { ...entry, recipe: before.recipe } : entry,
            );
          });
        },
      };
    },

    onError: (_error, _input, context) => {
      context?.undo();
    },

    onSuccess: (result, input) => {
      if (input.mode !== "add" || !result.plan) return;
      const weekStart = result.plan.week_start;
      queryClient.setQueryData<MealPlan | null>(
        mealPlanKey(input.householdId, weekStart),
        result.plan,
      );
      if (result.planId === input.planId) return;
      // Another device made the week first, so the entry belongs to its plan. Carry the optimistic
      // list across so the screen does not blink to empty while the refetch runs.
      const from = mealPlanEntriesKey(input.householdId, input.planId);
      const carried = queryClient.getQueryData<PlanEntry[]>(from);
      if (carried) {
        queryClient.setQueryData<PlanEntry[]>(
          mealPlanEntriesKey(input.householdId, result.planId),
          carried.map((entry) => ({ ...entry, plan_id: result.planId })),
        );
      }
      queryClient.removeQueries({ queryKey: from, exact: true });
    },

    onSettled: async (result, _error, input, context) => {
      await invalidateMealPlan(queryClient, {
        householdId: input.householdId,
        weekStart:
          context?.weekStart ?? (input.mode === "add" ? weekStartFor(input.entry.date) : null),
        planId: result?.planId ?? input.planId,
      });
    },
  };
}

/**
 * Adds or edits a planner entry, optimistically and idempotently. See upsertEntryOptions.
 *
 *   mutate({ mode: "add", id, householdId, planId, planIsNew, entry: { date, slot, recipe_id, servings } })
 *   mutate({ mode: "edit", id, householdId, planId, patch: { servings: 6 } })
 *
 * Marking an entry cooked or skipped, adding a recipe, and swapping one also write the
 * recipe_feedback signals (saved, cooked, skipped); the database does that in the same
 * transaction, so there is nothing to call.
 */
export function useUpsertEntry() {
  const client = useSupabase();
  const queryClient = useQueryClient();
  return useMutation(upsertEntryOptions(client, queryClient));
}
