import type { Allergen, Diet } from "@mp/core";

/** Words for the diet chips. Every member of DIETS has one (labels.test.ts checks). */
export const DIET_LABEL: Record<Diet, string> = {
  omnivore: "I eat everything",
  vegetarian: "Vegetarian",
  vegan: "Vegan",
  pescatarian: "Pescatarian",
  halal: "Halal",
  kosher: "Kosher",
  gluten_free: "Gluten free",
  dairy_free: "Dairy free",
  low_carb: "Low carb",
  keto: "Keto",
  paleo: "Paleo",
};

/** Diets the suggestions can enforce from ingredients. The rest only steer taste. */
export const DIET_NOTE: Partial<Record<Diet, string>> = {
  low_carb: "Steers suggestions. We cannot check carbs from an ingredient list.",
  keto: "Steers suggestions. We cannot check carbs from an ingredient list.",
  paleo: "Steers suggestions. We cannot check it from an ingredient list.",
};

export const ALLERGEN_LABEL: Record<Allergen, string> = {
  peanut: "Peanuts",
  tree_nut: "Tree nuts",
  milk: "Milk",
  egg: "Eggs",
  wheat: "Wheat",
  soy: "Soy",
  fish: "Fish",
  shellfish: "Shellfish",
  sesame: "Sesame",
};

export function titleCase(text: string): string {
  return text.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Said under the allergy chips. The filters are strict, but they match words in ingredient lists,
 * so a food a recipe never names is not caught. The person keeps reading labels.
 */
export const ALLERGY_NOTE =
  "We leave out recipes whose ingredient lists mention these. Always read labels and recipes yourself: a list can leave an ingredient out.";
