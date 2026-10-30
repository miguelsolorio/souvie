// Turns what the scrapers and the model produce into a `NormalizedRecipe` (WS02). Everything the
// app stores passes through `NormalizedRecipe.safeParse`, so a bad value is repaired here
// (trimmed, clamped, dropped) or the recipe is rejected, never half-saved.
//
// Ingredient lines stay as raw text: WS03 parses them into quantity, unit, and ingredient.

import { NormalizedRecipe, RECIPE_LIMITS } from "@mp/core";
import type { RecipeExtractOutput } from "@mp/llm";

/** The slice of recipe-scrapers' `RecipeObject` this package reads. */
export interface ScrapedRecipe {
  title: string;
  description?: string | null;
  image?: string | null;
  yields?: string | null;
  prepTime?: number | null;
  cookTime?: number | null;
  totalTime?: number | null;
  ingredients: ReadonlyArray<{ name: string | null; items: ReadonlyArray<{ value: string }> }>;
  instructions: ReadonlyArray<{ name: string | null; items: ReadonlyArray<{ value: string }> }>;
  nutrients?: Record<string, string> | null;
  keywords?: readonly string[] | null;
  category?: readonly string[] | null;
  cuisine?: readonly string[] | null;
}

const TRACKING_PARAM =
  /^(utm_[a-z_]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|igsh|ref_src|_ga|oly_[a-z_]+)$/i;

/** The address to store as the recipe's source: no fragment, no tracking parameters. */
export function cleanSourceUrl(raw: string): string {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return raw.trim();
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
    }
    return url.href;
  } catch {
    return raw.trim();
  }
}

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function collapse(text: string): string {
  return text
    .replace(/\u00a0|\u200b|\u200c|\u200d|\ufeff/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Bullet, checkbox, and dash characters are written as escapes so they stay visible in review.
const LEADING_LIST_MARKS = /^[\s\u2022\u25aa\u25cf\u25a2\u2610\u2611\u2713\u2714*\-\u2013\u2014]+/;
const LEADING_BULLETS = /^[\s\u2022\u25aa\u25cf*\-\u2013\u2014]+/;

/** An ingredient line without list bullets, checkbox glyphs, or surrounding space. */
export function cleanIngredientLine(text: string): string {
  return collapse(text.replace(LEADING_LIST_MARKS, ""));
}

/**
 * A step label at the start of a line: "Step 3", "Step 3:", "Step 3 -", or a bare number followed
 * directly by `.`, `)` or `:` ("1.", "2)", "3:"). A bare number with a space before the
 * punctuation is part of the sentence, as in "30 - 40 minutes in the oven", and so are decimals
 * and quantities ("1.5 cups", "350 degrees").
 */
const STEP_LABEL = /^(?:step\s*\d{1,2}\s*[.):-]?|\d{1,2}[.):])\s+/i;

/** A step without its number ("1.", "1)", "Step 1:") or bullet. */
export function cleanStep(text: string): string {
  return collapse(text.replace(LEADING_BULLETS, "").replace(STEP_LABEL, ""));
}

/** The first number in a yield such as "4 servings", "4-6 servings", or "Makes 12 cookies". */
export function parseServings(yields: string | null | undefined): number | undefined {
  if (!yields) return undefined;
  const match = /(\d+(?:\.\d+)?)/.exec(yields);
  if (!match?.[1]) return undefined;
  const value = Number.parseFloat(match[1]);
  return value > 0 && value <= RECIPE_LIMITS.servingsMax ? value : undefined;
}

function minutes(value: number | null | undefined): number | undefined {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0)
    return undefined;
  const rounded = Math.round(value);
  return rounded <= RECIPE_LIMITS.minutesMax ? rounded : undefined;
}

/** Keeps http(s) URLs and upgrades protocol-relative ones. Anything else is not an image link. */
export function cleanImageUrl(raw: string | null | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const absolute = value.startsWith("//") ? `https:${value}` : value;
  return /^https?:\/\/[^\s]+$/i.test(absolute) && absolute.length <= RECIPE_LIMITS.url
    ? absolute
    : undefined;
}

function tagList(...lists: Array<readonly string[] | null | undefined>): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const list of lists) {
    for (const item of list ?? []) {
      const tag = collapse(item).toLowerCase();
      if (!tag || tag.length > 40 || /https?:|@/.test(tag) || seen.has(tag)) continue;
      seen.add(tag);
      tags.push(tag);
      if (tags.length >= 10) return tags;
    }
  }
  return tags;
}

/** "Ingredients" is a label some sites give the only group, not a section heading. */
function groupLabel(name: string | null): string | undefined {
  const label = name ? collapse(name) : "";
  if (!label || /^ingredients?:?$/i.test(label)) return undefined;
  return clamp(label.replace(/:$/, ""), RECIPE_LIMITS.groupName);
}

function nutrition(nutrients: Record<string, string> | null | undefined) {
  if (!nutrients) return undefined;
  const entries = Object.entries(nutrients)
    .map(([key, value]) => [collapse(key), collapse(String(value))] as const)
    .filter(([key, value]) => key && value && key.length <= 60 && value.length <= 80)
    .slice(0, 20);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** What a `NormalizedRecipe` is built from, before validation. */
interface Draft {
  title: string;
  description?: string | undefined;
  imageUrl?: string | undefined;
  sourceUrl?: string | undefined;
  servings?: number | undefined;
  prepMin?: number | undefined;
  cookMin?: number | undefined;
  ingredients: Array<{ rawText: string; groupName?: string | undefined }>;
  instructions: string[];
  nutrition?: Record<string, string> | undefined;
  tags?: string[] | undefined;
  cuisine?: string | undefined;
}

/** Drops undefined keys, clamps lengths, and validates. Null when nothing usable is left. */
function finish(draft: Draft): NormalizedRecipe | null {
  const ingredients = draft.ingredients
    .map((line) => ({ ...line, rawText: cleanIngredientLine(line.rawText) }))
    .filter((line) => line.rawText.length > 0)
    .slice(0, RECIPE_LIMITS.ingredients)
    .map((line) => ({
      rawText: clamp(line.rawText, RECIPE_LIMITS.ingredientText),
      ...(line.groupName ? { groupName: line.groupName } : {}),
    }));
  const instructions = draft.instructions
    .map(cleanStep)
    .filter((step) => step.length > 0)
    .slice(0, RECIPE_LIMITS.instructions)
    .map((step) => clamp(step, RECIPE_LIMITS.instructionText));
  const title = clamp(collapse(draft.title), RECIPE_LIMITS.title);
  const description = draft.description ? collapse(draft.description) : "";

  const candidate = {
    title,
    ...(description ? { description: clamp(description, RECIPE_LIMITS.description) } : {}),
    ...(draft.imageUrl ? { imageUrl: draft.imageUrl } : {}),
    ...(draft.sourceUrl ? { sourceUrl: draft.sourceUrl } : {}),
    ...(draft.servings !== undefined ? { servings: draft.servings } : {}),
    ...(draft.prepMin !== undefined ? { prepMin: draft.prepMin } : {}),
    ...(draft.cookMin !== undefined ? { cookMin: draft.cookMin } : {}),
    ingredients,
    instructions,
    ...(draft.nutrition ? { nutrition: draft.nutrition } : {}),
    ...(draft.tags && draft.tags.length > 0 ? { tags: draft.tags } : {}),
    ...(draft.cuisine ? { cuisine: clamp(collapse(draft.cuisine), RECIPE_LIMITS.cuisine) } : {}),
  };
  const parsed = NormalizedRecipe.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  deg: "°",
};

/** Decodes the HTML entities that appear in JSON-LD text ("&amp;", "&#8211;", "&#x2019;"). */
export function decodeEntities(text: string): string {
  return text.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|([a-z][a-z0-9]*));/gi,
    (match, dec?: string, hex?: string, name?: string) => {
      if (dec !== undefined || hex !== undefined) {
        const code = dec !== undefined ? Number(dec) : Number.parseInt(hex ?? "", 16);
        return Number.isInteger(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : match;
      }
      return NAMED_ENTITIES[String(name).toLowerCase()] ?? match;
    },
  );
}

function lineKey(text: string): string {
  return collapse(decodeEntities(text)).toLowerCase();
}

/**
 * recipe-scrapers drops repeated ingredient lines (it collects them in a Set), so "1/2 teaspoon
 * salt" listed once for the batter and once for the filling comes back once. For a shopping list
 * that under-counts. Given the page's own list (`reference`), this puts each missing repeat back
 * right after the first copy.
 */
export function restoreRepeatedLines<T extends { rawText: string }>(
  lines: readonly T[],
  reference: readonly string[],
): T[] {
  const wanted = new Map<string, number>();
  for (const line of reference) {
    const key = lineKey(line);
    if (key) wanted.set(key, (wanted.get(key) ?? 0) + 1);
  }
  const have = new Map<string, number>();
  for (const line of lines) {
    const key = lineKey(line.rawText);
    have.set(key, (have.get(key) ?? 0) + 1);
  }
  const out: T[] = [];
  const restored = new Set<string>();
  for (const line of lines) {
    out.push(line);
    const key = lineKey(line.rawText);
    const missing = (wanted.get(key) ?? 0) - (have.get(key) ?? 0);
    if (missing > 0 && !restored.has(key)) {
      restored.add(key);
      for (let i = 0; i < missing; i++) out.push({ ...line });
    }
  }
  return out;
}

export interface ScrapedContext {
  /** The page's own `recipeIngredient` lines, used to restore repeats the library drops. */
  referenceIngredients?: readonly string[] | undefined;
}

/** From a recipe-scrapers result. Null when the result cannot be a valid recipe. */
export function normalizeScraped(
  raw: ScrapedRecipe,
  sourceUrl: string,
  context: ScrapedContext = {},
): NormalizedRecipe | null {
  const scraped = raw.ingredients.flatMap((group) => {
    const groupName = groupLabel(group.name);
    return group.items.map((item) => ({ rawText: item.value, groupName }));
  });
  const ingredients = context.referenceIngredients
    ? restoreRepeatedLines(scraped, context.referenceIngredients)
    : scraped;
  const prep = minutes(raw.prepTime);
  const cook = minutes(raw.cookTime);
  const cuisine = raw.cuisine
    ?.map(collapse)
    .find((c) => c.length > 0)
    ?.toLowerCase();
  return finish({
    title: raw.title,
    description: raw.description ?? undefined,
    imageUrl: cleanImageUrl(raw.image),
    sourceUrl: cleanSourceUrl(sourceUrl),
    servings: parseServings(raw.yields),
    prepMin: prep,
    cookMin: cook,
    ingredients,
    instructions: raw.instructions.flatMap((group) => group.items.map((item) => item.value)),
    nutrition: nutrition(raw.nutrients),
    tags: tagList(raw.category, raw.keywords),
    cuisine,
  });
}

export interface ModelNormalizeContext {
  /** Stored as the recipe's source_url. */
  sourceUrl?: string | undefined;
  /** From the page's own metadata; the model never supplies links. */
  imageUrl?: string | undefined;
}

/** From the model's answer. Null when it found no recipe or the answer is unusable. */
export function normalizeModelOutput(
  output: RecipeExtractOutput,
  context: ModelNormalizeContext = {},
): NormalizedRecipe | null {
  if (!output.found) return null;
  return finish({
    title: output.title,
    description: output.description ?? undefined,
    imageUrl: cleanImageUrl(context.imageUrl),
    sourceUrl: context.sourceUrl ? cleanSourceUrl(context.sourceUrl) : undefined,
    servings:
      output.servings !== null &&
      output.servings > 0 &&
      output.servings <= RECIPE_LIMITS.servingsMax
        ? output.servings
        : undefined,
    prepMin: minutes(output.prep_minutes),
    cookMin: minutes(output.cook_minutes),
    ingredients: output.ingredients.map((line) => ({
      rawText: line.text,
      groupName: line.group ? groupLabel(line.group) : undefined,
    })),
    instructions: output.steps,
    tags: tagList(output.tags),
    cuisine: output.cuisine?.toLowerCase() ?? undefined,
  });
}

/** Why a normalized recipe is thinner than expected, as short codes for the UI. */
export function recipeWarnings(recipe: NormalizedRecipe): string[] {
  const warnings: string[] = [];
  if (recipe.instructions.length === 0) warnings.push("no_instructions");
  if (recipe.ingredients.length < 2) warnings.push("few_ingredients");
  return warnings;
}
