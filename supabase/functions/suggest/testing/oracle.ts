// Test harness only (WS06): the independent check for the hard filters.
//
// filters.ts decides from term lists. This file decides from the human-authored labels in the
// corpus (what each recipe really contains and which diets it breaks), so a recipe the term
// lists miss shows up here as a violation. It shares no code with filters.ts.
import type { ProfilePreferences } from "../../../../packages/core/src/index.ts";
import type { CorpusRecipe } from "./corpus.ts";

const NOT_DINNER = new Set([
  "dessert",
  "desserts",
  "drink",
  "drinks",
  "breakfast",
  "snack",
  "snacks",
]);

/** Diets that the filters enforce. The others (omnivore, low_carb, keto, paleo) are taste only. */
const ENFORCED = new Set([
  "vegetarian",
  "vegan",
  "pescatarian",
  "halal",
  "kosher",
  "gluten_free",
  "dairy_free",
]);

function stem(word: string): string {
  const w = word.trim().toLowerCase();
  if (w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.endsWith("es") && w.length > 4) return w.slice(0, -2);
  if (w.endsWith("s") && w.length > 3) return w.slice(0, -1);
  return w;
}

/** What a recipe line really contains: its parsed name, or the hand-written truth for the rest. */
function truthOf(line: CorpusRecipe["lines"][number]): string {
  return (line[2] ?? line[1] ?? line[0]).toLowerCase();
}

/** Every way the recipe breaks the household's rules, judged from labels only. */
export function oracleViolations(prefs: ProfilePreferences, recipe: CorpusRecipe): string[] {
  const reasons: string[] = [];
  if (recipe.owner === "other") reasons.push("belongs to another household");
  if (recipe.deleted) reasons.push("is deleted");
  for (const tag of recipe.tags) {
    if (NOT_DINNER.has(tag.toLowerCase())) reasons.push(`is not a dinner (${tag})`);
  }
  const total = (recipe.prepMin ?? 0) + (recipe.cookMin ?? 0);
  if (prefs.weeknight_minutes && total > 0 && total > prefs.weeknight_minutes) {
    reasons.push(`takes ${total} min, over ${prefs.weeknight_minutes}`);
  }
  for (const allergen of prefs.allergies ?? []) {
    if (recipe.labels.contains.includes(allergen)) reasons.push(`contains ${allergen}`);
  }
  for (const diet of prefs.diets ?? []) {
    if (ENFORCED.has(diet) && recipe.labels.breaks.includes(diet)) reasons.push(`breaks ${diet}`);
  }
  for (const dislike of prefs.dislikes ?? []) {
    // A never-food is the ingredient itself or a kind of it ("onion" for "red onion"), not a
    // different food that shares a word ("olive" is not "olive oil").
    const wanted = dislike
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter(Boolean)
      .map(stem)
      .join(" ");
    for (const line of recipe.lines) {
      const name = truthOf(line)
        .split(/[^a-z]+/)
        .filter(Boolean)
        .map(stem)
        .join(" ");
      if (name === wanted || name.endsWith(` ${wanted}`)) {
        reasons.push(`has never-food ${dislike}`);
        break;
      }
    }
  }
  return reasons;
}
