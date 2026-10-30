// Caption import (WS02): the text that arrives with a share-sheet post or a pasted link's caption
// (docs/03-ai-design.md §4). Caption-only is a product rule, not a shortcut (R11): this module
// never fetches anything, never downloads media, never reads a transcript. The caller hands it
// text; it hands back a recipe or a typed "not enough text" result.
//
// `ingredientLikeLines` lives in share.ts, which the app also imports, so it can show the "not
// enough text in caption" state before any request is made (acceptance criterion 7).
// `importFromCaption` checks again.

import { IMPORT_LIMITS } from "@mp/core";
import { cleanSourceUrl, normalizeModelOutput, recipeWarnings } from "./normalize.ts";
import { failure, type ImportDeps, type ImportResult } from "./schema.ts";
import { hasEnoughCaptionText } from "./share.ts";
import { runExtraction } from "./text.ts";

export interface CaptionOptions {
  /** The shared post's link. Stored as the recipe's source_url; never fetched. */
  sourceUrl?: string | undefined;
}

/**
 * A caption to a recipe. Returns `not_enough_text` without calling the model when the caption has
 * fewer than two ingredient-like lines, so the UI can offer photo or paste instead.
 */
export async function importFromCaption(
  caption: string,
  deps: ImportDeps = {},
  options: CaptionOptions = {},
): Promise<ImportResult> {
  const text = caption.trim().slice(0, IMPORT_LIMITS.captionMax);
  if (!hasEnoughCaptionText(text)) {
    return failure(
      "not_enough_text",
      "There is not enough text in the caption to make a recipe. Take a photo or paste the recipe.",
    );
  }
  const sourceUrl = options.sourceUrl ? cleanSourceUrl(options.sourceUrl) : undefined;
  const run = await runExtraction(deps, { source: "caption", text, sourceUrl });
  if (!run.ok) return run;

  const recipe = normalizeModelOutput(run.output, { sourceUrl });
  if (!recipe) {
    return failure(
      "not_enough_text",
      "There is not enough text in the caption to make a recipe. Take a photo or paste the recipe.",
    );
  }
  return { ok: true, recipe, path: "caption", warnings: recipeWarnings(recipe) };
}
