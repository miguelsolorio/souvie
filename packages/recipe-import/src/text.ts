// Pasted-text import (WS02): Sonnet structured extraction, no fallback (docs/03 §4). This file
// also holds `runExtraction`, the one place the model-backed importers (text, caption, photo, and
// the page-text fallback of the URL path) call the model, so they share the prompt, the schema,
// the logging fields, and the error mapping.

import { IMPORT_LIMITS } from "@mp/core";
import {
  type ExtractImage,
  RECIPE_EXTRACT_V1,
  RecipeExtractOutput,
  type RecipeExtractSource,
} from "@mp/llm";
import { normalizeModelOutput, recipeWarnings } from "./normalize.ts";
import {
  EXTRACT_KIND,
  failure,
  failureFromModelError,
  type ImportDeps,
  type ImportFailure,
  type ImportResult,
} from "./schema.ts";

export interface ExtractionArgs {
  source: RecipeExtractSource;
  /** The content. Empty for photos. */
  text: string;
  sourceUrl?: string | undefined;
  images?: readonly ExtractImage[] | undefined;
  /** Overrides the prompt's model, for the photo escalation to Opus. */
  model?: string | undefined;
}

/** One model call with the recipe prompt. Never throws. */
export async function runExtraction(
  deps: ImportDeps,
  args: ExtractionArgs,
): Promise<{ ok: true; output: RecipeExtractOutput } | ImportFailure> {
  if (!deps.extract) {
    return failure("model_unavailable", "Recipe reading is not available right now.");
  }
  try {
    const { value } = await deps.extract(RecipeExtractOutput, {
      system: RECIPE_EXTRACT_V1.system(),
      user: RECIPE_EXTRACT_V1.user({
        source: args.source,
        text: args.text,
        ...(args.sourceUrl ? { sourceUrl: args.sourceUrl } : {}),
      }),
      ...(args.images ? { images: args.images } : {}),
      ...(args.model ? { model: args.model } : {}),
      kind: EXTRACT_KIND,
      promptVersion: RECIPE_EXTRACT_V1.id,
      householdId: deps.householdId ?? null,
      check: (output) =>
        output.found && normalizeModelOutput(output) === null
          ? "the recipe has no usable title or ingredients"
          : null,
    });
    return { ok: true, output: value };
  } catch (err) {
    return failureFromModelError(err);
  }
}

/** Pasted recipe text to a recipe. */
export async function importFromText(text: string, deps: ImportDeps = {}): Promise<ImportResult> {
  const trimmed = text.trim();
  if (trimmed.length < IMPORT_LIMITS.textMin) {
    return failure("not_enough_text", "There is not enough text to make a recipe.");
  }
  const run = await runExtraction(deps, {
    source: "pasted_text",
    text: trimmed.slice(0, IMPORT_LIMITS.textMax),
  });
  if (!run.ok) return run;

  const recipe = normalizeModelOutput(run.output);
  if (!recipe) return failure("no_recipe_found", "We could not find a recipe in that text.");
  return { ok: true, recipe, path: "text", warnings: recipeWarnings(recipe) };
}
