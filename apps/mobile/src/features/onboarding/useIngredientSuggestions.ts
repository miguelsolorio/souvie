import { useSupabase } from "@mp/db";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

/**
 * Keeps letters, digits, spaces, apostrophes, and hyphens, lowercased. This goes into a LIKE
 * pattern, so % and _ must never reach it, and the rest is noise for a food name.
 */
export function cleanQuery(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 '-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

interface AliasRow {
  alias: string;
  ingredient: { name: string } | { name: string }[] | null;
}

/**
 * Ingredient names that start with what the person typed, from the ontology (WS03). A typed
 * alias ("scallion") offers the ingredient it belongs to ("green onion"). The ontology is global
 * reference data that every signed-in user may read.
 */
export function useIngredientSuggestions(query: string) {
  const client = useSupabase();
  const q = useDebounced(cleanQuery(query), 250);

  return useQuery({
    queryKey: ["ingredient-suggest", q],
    enabled: q.length >= 2,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<string[]> => {
      const [names, aliases] = await Promise.all([
        client.from("ingredients").select("name").ilike("name", `${q}%`).order("name").limit(8),
        client
          .from("ingredient_aliases")
          .select("alias, ingredient:ingredients(name)")
          .ilike("alias", `${q}%`)
          .order("alias")
          .limit(8),
      ]);
      if (names.error) throw new Error(names.error.message);
      const found = (names.data ?? []).map((row) => row.name);
      if (!aliases.error) {
        for (const row of (aliases.data ?? []) as unknown as AliasRow[]) {
          const target = Array.isArray(row.ingredient) ? row.ingredient[0] : row.ingredient;
          if (target?.name) found.push(target.name);
        }
      }
      return [...new Set(found)].slice(0, 8);
    },
  });
}
