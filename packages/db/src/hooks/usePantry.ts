import type { PantryItem, PantryStatus } from "@mp/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { useSupabase } from "../context";
import {
  clearPantryStatus,
  fetchIngredientsById,
  fetchPantry,
  fetchStapleIngredients,
  ingredientSearchKey,
  type PantryIngredient,
  pantryKey,
  searchIngredients,
  stapleIngredientsKey,
  writePantryStatus,
} from "../lists";
import { useHousehold } from "./useHousehold";

/** One line of the pantry screen. */
export interface PantryRow {
  ingredientId: string;
  name: string;
  category: string;
  /** What the list build uses: the household's row, else "have" for a staple. */
  status: PantryStatus;
  /** True when the status is the staple default and the household has no row of its own. */
  isDefault: boolean;
  isStaple: boolean;
}

const PANTRY_WRITE_SCOPE = { id: "pantry-writes" } as const;

/**
 * The pantry of the active household: the ontology's staples (salt, oil, flour, ...) as "have
 * (default)" until the household says otherwise, plus every ingredient it has marked. A row is
 * written only when the person changes a status; clearing a row returns the ingredient to its
 * default. `list-build` reads the same rows, so marking a staple `out` brings it back on the next
 * list and `have` takes it off (and under "Already have").
 *
 * Persisted like the list, so the pantry opens in a store with no signal.
 */
export function usePantry() {
  const client = useSupabase();
  const queryClient = useQueryClient();
  const household = useHousehold();
  const householdId = household.data?.id;

  const pantry = useQuery({
    queryKey: pantryKey(householdId),
    enabled: Boolean(householdId),
    meta: { persist: true },
    queryFn: () => {
      if (!householdId) return Promise.resolve([] as PantryItem[]);
      return fetchPantry(client, householdId);
    },
  });
  const staples = useQuery({
    queryKey: stapleIngredientsKey(),
    meta: { persist: true },
    staleTime: 24 * 60 * 60 * 1000,
    queryFn: () => fetchStapleIngredients(client),
  });

  // Rows for ingredients that are not staples need their names.
  const stapleIds = useMemo(() => new Set((staples.data ?? []).map((i) => i.id)), [staples.data]);
  const otherIds = useMemo(
    () => (pantry.data ?? []).map((row) => row.ingredient_id).filter((id) => !stapleIds.has(id)),
    [pantry.data, stapleIds],
  );
  const others = useQuery({
    queryKey: ["ingredients", "named", [...otherIds].sort()] as const,
    enabled: otherIds.length > 0 && staples.isSuccess,
    meta: { persist: true },
    queryFn: () => fetchIngredientsById(client, otherIds),
  });

  const rows = useMemo(
    () => buildPantryRows(pantry.data ?? [], staples.data ?? [], others.data ?? []),
    [pantry.data, staples.data, others.data],
  );

  const setStatus = useMutation({
    scope: PANTRY_WRITE_SCOPE,
    mutationFn: async (args: { ingredientId: string; status: PantryStatus }) => {
      if (!householdId) return;
      await writePantryStatus(client, { householdId, ...args });
    },
    onMutate: async (args) => {
      await queryClient.cancelQueries({ queryKey: pantryKey(householdId) });
      const before = queryClient.getQueryData<PantryItem[]>(pantryKey(householdId));
      queryClient.setQueryData<PantryItem[]>(pantryKey(householdId), (rows) =>
        withPantryStatus(rows, householdId ?? "", args.ingredientId, args.status),
      );
      return { before };
    },
    onError: (_error, _args, context) => {
      queryClient.setQueryData(pantryKey(householdId), context?.before);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: pantryKey(householdId) }),
  });

  const clear = useMutation({
    scope: PANTRY_WRITE_SCOPE,
    mutationFn: async (args: { ingredientId: string }) => {
      if (!householdId) return;
      await clearPantryStatus(client, { householdId, ...args });
    },
    onMutate: async (args) => {
      await queryClient.cancelQueries({ queryKey: pantryKey(householdId) });
      const before = queryClient.getQueryData<PantryItem[]>(pantryKey(householdId));
      queryClient.setQueryData<PantryItem[]>(pantryKey(householdId), (rows) =>
        (rows ?? []).filter((row) => row.ingredient_id !== args.ingredientId),
      );
      return { before };
    },
    onError: (_error, _args, context) => {
      queryClient.setQueryData(pantryKey(householdId), context?.before);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: pantryKey(householdId) }),
  });

  return {
    rows,
    isPending: pantry.isPending || staples.isPending,
    isError: pantry.isError || staples.isError,
    refetch: () => {
      void pantry.refetch();
      void staples.refetch();
    },
    setStatus: setStatus.mutate,
    clearStatus: clear.mutate,
    writeError: setStatus.error ?? clear.error ?? null,
  };
}

/** The pantry's rows: every staple (default have) and every other ingredient the household marked. */
export function buildPantryRows(
  pantry: readonly PantryItem[],
  staples: readonly PantryIngredient[],
  others: readonly PantryIngredient[],
): PantryRow[] {
  const byId = new Map(pantry.map((row) => [row.ingredient_id, row.status]));
  const rows: PantryRow[] = [];
  const seen = new Set<string>();
  for (const staple of staples) {
    seen.add(staple.id);
    const own = byId.get(staple.id);
    rows.push({
      ingredientId: staple.id,
      name: staple.name,
      category: staple.category,
      status: own ?? "have",
      isDefault: own === undefined,
      isStaple: true,
    });
  }
  for (const ingredient of others) {
    if (seen.has(ingredient.id)) continue;
    const own = byId.get(ingredient.id);
    if (own === undefined) continue;
    seen.add(ingredient.id);
    rows.push({
      ingredientId: ingredient.id,
      name: ingredient.name,
      category: ingredient.category,
      status: own,
      isDefault: false,
      isStaple: false,
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/** The rows with one status set (added if the household had no row for it). Pure. */
export function withPantryStatus(
  rows: readonly PantryItem[] | undefined,
  householdId: string,
  ingredientId: string,
  status: PantryStatus,
  now = new Date().toISOString(),
): PantryItem[] {
  const rest = (rows ?? []).filter((row) => row.ingredient_id !== ingredientId);
  return [
    ...rest,
    { household_id: householdId, ingredient_id: ingredientId, status, updated_at: now },
  ];
}

/** Ingredients whose name contains `term`, for adding one to the pantry. Idle under two letters. */
export function useIngredientSearch(term: string) {
  const client = useSupabase();
  const clean = term.trim().toLowerCase();
  return useQuery({
    queryKey: ingredientSearchKey(clean),
    enabled: clean.length >= 2,
    staleTime: 5 * 60 * 1000,
    queryFn: () => searchIngredients(client, clean),
  });
}
