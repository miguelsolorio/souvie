// Turns a recipe into the text the edit form shows and back (WS02). Pure, so it is unit-tested.
//
// The form keeps ingredients as one text box, one line per ingredient. A line is a section heading
// ("# For the sauce") when "#" is followed by a space and a name, or is a bare "#" that ends the
// section; it applies to the lines under it. "#10 can tomato paste" and "#sauce" have no space
// after the "#", so they are ingredients. Steps are one per line. Everything else (title, times,
// tags) is a plain field.

import {
  instructionsToSteps,
  type NormalizedRecipe,
  RECIPE_LIMITS,
  type RecipeWithIngredients,
} from "@mp/core";
import { checkDraft, type DraftIngredient, type RecipeDraft } from "@mp/db";

/** An existing ingredient line, so an edit can keep the parsed fields of lines left untouched. */
export interface ExistingLine {
  id: string;
  rawText: string;
  groupName?: string | undefined;
}

export interface FormState {
  title: string;
  description: string;
  servings: string;
  prepMin: string;
  cookMin: string;
  cuisine: string;
  tags: string;
  ingredients: string;
  steps: string;
  /** An external link or a path in recipe-images. Not edited in the form; carried through. */
  imageUrl: string | undefined;
  nutrition: Record<string, string> | undefined;
}

export function emptyForm(): FormState {
  return {
    title: "",
    description: "",
    servings: "",
    prepMin: "",
    cookMin: "",
    cuisine: "",
    tags: "",
    ingredients: "",
    steps: "",
    imageUrl: undefined,
    nutrition: undefined,
  };
}

// ---------------------------------------------------------------------------------------
// Lines of text
// ---------------------------------------------------------------------------------------

/**
 * "# For the sauce" or a bare "#" (back to no section). The "#" must be followed by a space, so
 * "#10 can tomato paste" and "#sauce" are ingredient lines. The name may start with any character,
 * so a section such as "5-Spice marinade" survives being written out and read back.
 */
export function isSectionHeading(line: string): boolean {
  return /^#+$/.test(line) || /^#+\s+\S/.test(line);
}

export function ingredientsToText(
  ingredients: ReadonlyArray<{ rawText: string; groupName?: string | undefined }>,
): string {
  const lines: string[] = [];
  let group: string | undefined;
  for (const item of ingredients) {
    const next = item.groupName?.trim() || undefined;
    if (next !== group) {
      lines.push(next ? `# ${next}` : "#");
      group = next;
    }
    lines.push(item.rawText);
  }
  return lines.join("\n");
}

/**
 * Reads the ingredients box. A line that matches an existing line (same text, same section) keeps
 * that line's id, so saving does not clear what the parser already worked out.
 */
export function textToIngredients(
  text: string,
  previous: readonly ExistingLine[] = [],
): DraftIngredient[] {
  const used = new Set<string>();
  const out: DraftIngredient[] = [];
  let group: string | undefined;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (isSectionHeading(line)) {
      group = line.replace(/^#+\s*/, "").trim() || undefined;
      continue;
    }
    const match = previous.find(
      (p) => !used.has(p.id) && p.rawText === line && (p.groupName?.trim() || undefined) === group,
    );
    if (match) used.add(match.id);
    out.push({
      ...(match ? { id: match.id } : {}),
      rawText: line,
      ...(group ? { groupName: group } : {}),
    });
  }
  return out;
}

/**
 * One step per paragraph. A line break inside a step becomes a space, because textToSteps starts a
 * new step at every line break: without this a multi-paragraph step would split on the next edit.
 */
export function stepsToText(steps: readonly string[]): string {
  return steps.map((step) => step.replace(/\s*\r?\n\s*/g, " ").trim()).join("\n\n");
}

/** Every line break starts a new step ("One step per line"); blank lines are skipped. */
export function textToSteps(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function tagsToText(tags: readonly string[] | undefined): string {
  return (tags ?? []).join(", ");
}

export function textToTags(text: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const part of text.split(",")) {
    const tag = part.trim().toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag.slice(0, RECIPE_LIMITS.tagLength));
    if (tags.length >= RECIPE_LIMITS.tags) break;
  }
  return tags;
}

// ---------------------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------------------

/** "4", "4.5", "1/2", or "1 1/2". Undefined for empty or unreadable input. */
export function parseAmount(text: string): number | undefined {
  const value = text.trim();
  if (!value) return undefined;
  const mixed = /^(\d+)\s+(\d+)\/(\d+)$/.exec(value);
  if (mixed) {
    const denominator = Number(mixed[3]);
    return denominator === 0 ? undefined : Number(mixed[1]) + Number(mixed[2]) / denominator;
  }
  const fraction = /^(\d+)\/(\d+)$/.exec(value);
  if (fraction) {
    const denominator = Number(fraction[2]);
    return denominator === 0 ? undefined : Number(fraction[1]) / denominator;
  }
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return undefined;
}

/** A whole number of minutes, or undefined. */
export function parseMinutes(text: string): number | undefined {
  const value = text.trim();
  return /^\d+$/.test(value) ? Number(value) : undefined;
}

// ---------------------------------------------------------------------------------------
// Form <-> draft
// ---------------------------------------------------------------------------------------

export function formFromDraft(draft: RecipeDraft): FormState {
  return {
    title: draft.title,
    description: draft.description ?? "",
    servings: draft.servings !== undefined ? String(draft.servings) : "",
    prepMin: draft.prepMin !== undefined ? String(draft.prepMin) : "",
    cookMin: draft.cookMin !== undefined ? String(draft.cookMin) : "",
    cuisine: draft.cuisine ?? "",
    tags: tagsToText(draft.tags),
    ingredients: ingredientsToText(draft.ingredients),
    steps: stepsToText(draft.instructions),
    imageUrl: draft.imageUrl,
    nutrition: draft.nutrition,
  };
}

export function draftFromForm(
  form: FormState,
  previous: readonly ExistingLine[] = [],
): RecipeDraft {
  return {
    title: form.title,
    description: form.description.trim() || undefined,
    imageUrl: form.imageUrl,
    servings: parseAmount(form.servings),
    prepMin: parseMinutes(form.prepMin),
    cookMin: parseMinutes(form.cookMin),
    tags: textToTags(form.tags),
    cuisine: form.cuisine.trim() || undefined,
    nutrition: form.nutrition,
    ingredients: textToIngredients(form.ingredients, previous),
    instructions: textToSteps(form.steps),
  };
}

export function draftFromNormalized(recipe: NormalizedRecipe): RecipeDraft {
  return {
    title: recipe.title,
    description: recipe.description,
    imageUrl: recipe.imageUrl,
    servings: recipe.servings,
    prepMin: recipe.prepMin,
    cookMin: recipe.cookMin,
    tags: recipe.tags,
    cuisine: recipe.cuisine,
    nutrition: recipe.nutrition,
    ingredients: recipe.ingredients.map((line) => ({
      rawText: line.rawText,
      ...(line.groupName ? { groupName: line.groupName } : {}),
    })),
    instructions: recipe.instructions,
  };
}

export function draftFromRecipe(recipe: RecipeWithIngredients): RecipeDraft {
  return {
    title: recipe.title,
    description: recipe.description ?? undefined,
    imageUrl: recipe.image_url ?? undefined,
    servings: recipe.servings ?? undefined,
    prepMin: recipe.prep_min ?? undefined,
    cookMin: recipe.cook_min ?? undefined,
    tags: recipe.tags,
    cuisine: recipe.cuisine ?? undefined,
    nutrition: recipe.nutrition ?? undefined,
    ingredients: recipe.ingredients.map((line) => ({
      id: line.id,
      rawText: line.raw_text,
      ...(line.group_name ? { groupName: line.group_name } : {}),
    })),
    instructions: instructionsToSteps(recipe.instructions),
  };
}

export function existingLines(recipe: RecipeWithIngredients): ExistingLine[] {
  return recipe.ingredients.map((line) => ({
    id: line.id,
    rawText: line.raw_text,
    groupName: line.group_name ?? undefined,
  }));
}

// ---------------------------------------------------------------------------------------
// Validation messages
// ---------------------------------------------------------------------------------------

export interface FormErrors {
  title?: string;
  ingredients?: string;
  servings?: string;
  prepMin?: string;
  cookMin?: string;
  form?: string;
}

export function formErrors(form: FormState): FormErrors {
  const errors: FormErrors = {};
  if (!form.title.trim()) errors.title = "Give the recipe a title.";
  if (textToIngredients(form.ingredients).length === 0) {
    errors.ingredients = "Add at least one ingredient, one per line.";
  }
  const servings = form.servings.trim();
  if (servings && (parseAmount(servings) === undefined || (parseAmount(servings) ?? 0) <= 0)) {
    errors.servings = "Use a number such as 4 or 1 1/2.";
  } else if ((parseAmount(servings) ?? 0) > RECIPE_LIMITS.servingsMax) {
    errors.servings = "That is too many servings.";
  }
  for (const key of ["prepMin", "cookMin"] as const) {
    const value = form[key].trim();
    if (value && parseMinutes(value) === undefined) errors[key] = "Use whole minutes.";
  }
  if (Object.keys(errors).length === 0) {
    const checked = checkDraft(draftFromForm(form));
    if (!checked.ok) errors.form = checked.message;
  }
  return errors;
}

export function hasErrors(errors: FormErrors): boolean {
  return Object.keys(errors).length > 0;
}
