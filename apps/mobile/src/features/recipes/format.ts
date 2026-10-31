// Small display helpers for recipes (WS02). Pure, so they are unit-tested.

import { recipeSourceDomain } from "@mp/core";
import type { RecipeSummary } from "@mp/db";

export function formatServings(servings: number | null | undefined): string | null {
  if (servings === null || servings === undefined || servings <= 0) return null;
  const text = Number.isInteger(servings) ? String(servings) : String(Number(servings.toFixed(2)));
  return servings === 1 ? "1 serving" : `${text} servings`;
}

/** "45 min", "1 hr", "1 hr 15 min". */
export function formatMinutes(minutes: number | null | undefined): string | null {
  if (minutes === null || minutes === undefined || minutes <= 0) return null;
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

/** Prep and cook time added together, when either is known. */
export function totalMinutes(
  prep: number | null | undefined,
  cook: number | null | undefined,
): number | null {
  const total = (prep ?? 0) + (cook ?? 0);
  return total > 0 ? total : null;
}

/** One line for the recipe list: servings, total time, and where it came from. */
export function summaryLine(recipe: RecipeSummary): string {
  return [
    formatServings(recipe.servings),
    formatMinutes(totalMinutes(recipe.prep_min, recipe.cook_min)),
    recipeSourceDomain(recipe.source_url),
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

/** Recipes whose title, tags, cuisine, or source domain contain every word of the query. */
export function filterRecipes(recipes: readonly RecipeSummary[], query: string): RecipeSummary[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) return [...recipes];
  return recipes.filter((recipe) => {
    const haystack = [
      recipe.title,
      recipe.cuisine ?? "",
      ...recipe.tags,
      recipeSourceDomain(recipe.source_url) ?? "",
    ]
      .join(" ")
      .toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/**
 * One line per written line. When the parser reads a line that names several ingredients ("salt
 * and pepper to taste"), it keeps the first on the line's own row and adds a row for each other,
 * all with the same position, section and text. The recipe shows what was written, once.
 */
export function collapseSplitLines<
  T extends { position: number; group_name: string | null; raw_text: string },
>(lines: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const line of lines) {
    const key = `${line.position}\u0000${line.group_name ?? ""}\u0000${line.raw_text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

/** A recipe's ingredient lines split into runs that share a section heading, in order. */
export function groupIngredientLines<T extends { id: string; group_name: string | null }>(
  lines: readonly T[],
): Array<{ key: string; name: string | null; lines: T[] }> {
  const groups: Array<{ key: string; name: string | null; lines: T[] }> = [];
  for (const line of lines) {
    const name = line.group_name?.trim() || null;
    const last = groups[groups.length - 1];
    if (last && last.name === name) last.lines.push(line);
    // The first line's id is stable, so it makes a good React key for the group.
    else groups.push({ key: line.id, name, lines: [line] });
  }
  return groups;
}

/** Steps with their 1-based number, for display. */
export function numberSteps(steps: readonly string[]): Array<{ n: number; text: string }> {
  return steps.map((text, i) => ({ n: i + 1, text }));
}
