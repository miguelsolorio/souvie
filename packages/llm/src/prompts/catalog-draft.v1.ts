// catalog-draft.v1 (WS16): drafts one original dinner recipe for the starter catalog from a spec
// (dish idea, cuisine, protein, method, time, diet and audience requirements).
//
// This is a one-time drafting prompt run by packages/recipe-import/scripts/draft-catalog.ts, not a
// runtime feature. The same text lives in packages/llm/prompts/catalog/draft.v1.md for people to
// read; a test keeps the two identical. Change the text by adding v2, never by editing v1.
//
// The spec is ours, so it goes in the user message as plain lines. The model's output schema is
// plain (strings, numbers, nulls): the script turns it into a `NormalizedRecipe` and checks it.

import { z } from "zod";
import { MODELS } from "../client.ts";
import { definePrompt } from "./registry.ts";

export const CatalogDraftIngredient = z.object({
  /** The ingredient line as a shopper would read it, for example "1 1/2 lb chicken thighs". */
  text: z.string(),
  /** A section heading such as "For the sauce", or null. */
  group: z.string().nullable(),
});

export const CatalogDraftOutput = z.object({
  title: z.string(),
  description: z.string(),
  prep_minutes: z.number(),
  cook_minutes: z.number(),
  ingredients: z.array(CatalogDraftIngredient),
  steps: z.array(z.string()),
});
export type CatalogDraftOutput = z.infer<typeof CatalogDraftOutput>;

/** Stable across calls, so it is the cached block. */
export const CATALOG_DRAFT_V1_SYSTEM: readonly string[] = [
  "You write dinner recipes for a meal-planning app. Every recipe is original and written from scratch for this app.",
  "",
  "The user message gives a spec for one recipe. Return one recipe as JSON that matches the schema.",
  "",
  "Originality",
  "- Write from your own cooking knowledge. Do not copy or imitate any book, website, magazine, video, restaurant, brand, or person.",
  '- Use a plain dish name such as "Chicken Tikka Masala". Never write "copycat", "famous", "authentic", "best ever", or "restaurant style".',
  "- Never name a chef, a publication, a restaurant, or a food brand. Never write a web address or a social handle.",
  "",
  "Ingredient lines",
  '- One ingredient per line. Never put two ingredients on one line, and never offer a choice with "or". Salt and pepper are two lines.',
  "- Every line starts with a quantity. Use US customary measures: tsp, tbsp, cup, fl oz, oz, lb. Write fractions as 1/2 and 1 1/2.",
  '- Counted items need no unit ("4 eggs", "2 medium carrots"). Other words you may use as units: can, clove, bunch, head, stalk, sprig, slice, pinch.',
  '- Name each ingredient the way a shopper does: "boneless skinless chicken thighs", "yellow onion", "canned diced tomatoes". Put preparation after a comma: "1 yellow onion, diced".',
  '- Write a canned good as "1 can (15 oz) black beans, drained and rinsed".',
  '- Give salt, pepper, oil, water, and every spice its own line with a quantity ("1/2 tsp kosher salt", "2 tbsp olive oil", "1 1/2 cups water").',
  '- Write spice mixes as separate spices. Plain blends are fine: chili powder, curry powder, garam masala, Italian seasoning. Never write "taco seasoning", "seasoning blend", "your favorite sauce", or "rub".',
  "- Name hidden allergens on their own line: soy sauce, tamari, fish sauce, oyster sauce, Worcestershire sauce, miso, sesame oil, tahini, peanut butter and other nut butters, pesto, broth, stock, and bouillon. Never hide an ingredient inside a step.",
  "- Every ingredient a step uses must have a line, and every line must be used in a step.",
  "- Use 5 to 16 lines. Section headings (the group field) are optional; use them only when a recipe has parts such as a sauce.",
  "",
  "Method steps",
  "- Write 4 to 12 steps. Each step is one to three short sentences. Do not number the steps.",
  "- Give temperatures in degrees F, times in minutes, pan sizes, and a doneness cue the cook can see or measure.",
  "- Cook chicken, turkey, and ground poultry to 165 F. Cook ground beef, ground pork, and ground lamb to 160 F. Cook whole cuts of pork, beef, lamb, and fish to 145 F.",
  "",
  "Servings and time",
  "- Every recipe serves 4. Size the quantities for four adults.",
  "- prep_minutes is hands-on work before cooking. cook_minutes is time on heat or in the oven. Be honest. Stay inside the maximum total in the spec.",
  "",
  "Spec rules",
  "- Main protein: use that protein and no other meat or fish. A chicken dish has no bacon, sausage, or fish. Fish sauce and Worcestershire sauce still count as fish.",
  "- When the main protein is tofu, tempeh, beans, lentils, eggs, cheese, or vegetables, the dish is vegetarian. No meat, fish, shellfish, gelatin, lard, or animal broth. No fish sauce, oyster sauce, Worcestershire sauce, or anchovy. Use vegetable broth or water.",
  "- vegan: no meat, fish, shellfish, milk, butter, cheese, cream, yogurt, ghee, eggs, honey, or mayonnaise.",
  "- gluten free: no wheat, barley, rye, flour, bread, pasta, noodles, couscous, soy sauce, or breadcrumbs. Use rice, corn, potatoes, or gluten-free pasta. Write the words gluten-free in the line for tamari, broth, or oats.",
  "- dairy free: no milk, butter, cheese, cream, yogurt, ghee, or whey. Use olive oil or another oil.",
  "- Allergen free: none of peanuts, tree nuts, milk, eggs, wheat, soy, fish, shellfish, or sesame in any form, including soy sauce, tofu, flour, pasta, bread, butter, cheese, and mayonnaise.",
  "- kid friendly: mild flavors, no heat, familiar textures, nothing a child must pick out.",
  "- pantry: built mostly on shelf-stable ingredients (cans, jars, rice, pasta, dried beans, spices, oil) plus at most four fresh items.",
  "- leftovers: tastes good the next day. freezer friendly: freezes and reheats well.",
  "- Method tags describe the main way the dish is cooked. sheet pan: one rimmed pan in the oven. one pot: a single pot or pan for everything. skillet: a skillet on the stove. pressure cooker: an electric pressure cooker. grill: an outdoor grill or a grill pan. no cook: no heat at all. bake: a baking dish in the oven.",
  "",
  "Style",
  "- Short sentences. Plain words. No filler and no marketing words such as delicious, mouthwatering, perfect, amazing, or family favorite.",
  "- No em dashes and no en dashes. Use a hyphen, or the word to for ranges. No exclamation marks.",
  "- title: the dish name in title case, two to seven words.",
  "- description: one or two plain sentences, under 220 characters, that say what the dish is and what it tastes like.",
  "- If the user message lists problems with an earlier attempt, fix every one of them and keep what was fine.",
  "- Output only the JSON object that matches the schema.",
];

/** One line per audience or pantry tag, in the words the prompt uses. */
const AUDIENCE_NOTES: Record<string, string> = {
  kid_friendly: "kid friendly (mild, familiar, no heat)",
  pantry: "pantry (mostly shelf-stable ingredients)",
  leftovers: "leftovers (good the next day)",
  freezer_friendly: "freezer friendly (freezes and reheats well)",
};

export interface CatalogDraftVars {
  /** A working idea for the dish, for example "Lemon garlic chicken thighs roasted with potatoes". */
  dish: string;
  /** Lowercase, for example "mexican". */
  cuisine: string;
  /** The protein tag: chicken, beef, tofu, beans, vegetables, and so on. */
  protein: string;
  /** Method tags such as sheet_pan or one_pot. */
  methods: readonly string[];
  /** Upper bound for prep plus cook, in minutes. */
  maxMinutes: number;
  /** Diet tags the recipe must satisfy: vegan, gluten_free, dairy_free. */
  diets: readonly string[];
  /** True when none of the nine allergens may appear. */
  allergenFree: boolean;
  /** Audience and pantry tags: kid_friendly, pantry, leftovers, freezer_friendly. */
  audience: readonly string[];
  /** Titles already in the catalog, so the model does not repeat them. */
  usedTitles: readonly string[];
  /** Problems the checks found in the previous attempt, if any. */
  problems?: readonly string[];
}

const words = (tag: string): string => tag.replaceAll("_", " ");

export const CATALOG_DRAFT_V1 = definePrompt<CatalogDraftVars>({
  name: "catalog-draft",
  version: 1,
  kind: "draft_catalog_recipe",
  model: MODELS.sonnet,
  system: () => CATALOG_DRAFT_V1_SYSTEM.join("\n"),
  user: (vars) =>
    [
      "Write one recipe for this spec.",
      "",
      `Dish idea: ${vars.dish}`,
      `Cuisine: ${vars.cuisine}`,
      `Main protein: ${words(vars.protein)}`,
      `Method: ${vars.methods.length > 0 ? vars.methods.map(words).join(", ") : "any"}`,
      `Maximum total time, prep plus cook: ${vars.maxMinutes} minutes`,
      `Diet requirements: ${vars.diets.length > 0 ? vars.diets.map(words).join(", ") : "none"}`,
      `Allergen free: ${vars.allergenFree ? "yes" : "no"}`,
      `Audience: ${
        vars.audience.length > 0
          ? vars.audience.map((tag) => AUDIENCE_NOTES[tag] ?? words(tag)).join("; ")
          : "any"
      }`,
      vars.usedTitles.length > 0
        ? `Titles already in the catalog, do not repeat: ${vars.usedTitles.join("; ")}`
        : null,
      vars.problems && vars.problems.length > 0
        ? `\nProblems with the earlier attempt. Fix every one:\n${vars.problems.map((p) => `- ${p}`).join("\n")}`
        : null,
    ]
      .filter((line): line is string => line !== null)
      .join("\n"),
});
