// Haiku prompt for the fallback stage (WS03). Lives here until WS02 creates the prompt registry
// in packages/llm; then it moves to packages/llm/src/prompts/ingredient-parse.v1.ts unchanged.

import { INGREDIENT_CATEGORIES, UNIT_CODES } from "@mp/core";

export const INGREDIENT_PARSE_PROMPT_VERSION = "ingredient-parse.v1";

/** Stable across calls, so it is the cached block. */
export function buildSystemPrompt(): string {
  return [
    "You parse recipe ingredient lines into structured data. Return one result per input line.",
    "",
    "For each line, return `items`: one entry per distinct ingredient the line names.",
    'Most lines have one item. "salt and pepper to taste" has two (salt, black pepper).',
    "",
    "Fields of an item:",
    "- qty: the amount as a decimal number, or null when none is written (fractions become decimals: 1 1/2 is 1.5). For a range, qty is the low end.",
    "- qty_max: the high end of a range ('2-3', '1 to 2'), otherwise null.",
    `- unit: exactly one of ${UNIT_CODES.join(", ")}, or null when there is no quantity. A counted item with no unit word ('3 carrots') uses each. Size words (small, medium, large) are units. Convert spellings to these codes ('tablespoons' is tbsp, 'fl oz' is fl_oz).`,
    "- When a package size is given, as in '1 (14 oz) can diced tomatoes', use the package contents: qty 14, unit oz. For '2 (14 oz) cans' multiply: qty 28, unit oz.",
    "- ingredient: the plain name of the ingredient, singular and lowercase, with no preparation, size, brand, or quantity words ('2 cups diced yellow onion' gives 'yellow onion'). Keep words that change what you buy ('brown sugar', 'canned diced tomatoes' stays 'diced tomatoes', 'dried oregano').",
    `- category: the store section of the ingredient, one of ${INGREDIENT_CATEGORIES.join(", ")}.`,
    "- prep: preparation and qualifiers as short text ('finely chopped', 'divided', 'to taste', 'at room temperature'), or null.",
    "- optional: true only when the line says optional.",
    "- confidence: 0 to 1, your certainty that qty, unit, and ingredient are right.",
    "",
    "Rules:",
    "- Never invent a quantity. If none is written, qty and unit are null.",
    "- Never merge two lines or split one ingredient into two.",
    "- If a line is not an ingredient (a heading such as 'For the sauce:'), return an item with ingredient null and confidence 0.",
    "- Output only the JSON object that matches the schema.",
  ].join("\n");
}

/** Numbered lines, so the model answers by index. */
export function buildUserPrompt(lines: readonly string[]): string {
  return ["Parse these ingredient lines.", "", ...lines.map((line, i) => `${i}: ${line}`)].join(
    "\n",
  );
}
