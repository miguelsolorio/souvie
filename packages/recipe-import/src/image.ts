// Photo import (WS02): Claude vision reads a photo of a recipe card or a cookbook page into the
// same schema as every other path. The caller shows the result as an editable draft; nothing is
// saved until the person confirms (acceptance criterion 6). docs/03-ai-design.md §4.
//
// A partial reading (a recipe with almost no ingredients or no steps) is retried once on Opus,
// the escalation tier in docs/03 §1.

import { type ExtractImage, MODELS } from "@mp/llm";
import { normalizeModelOutput, recipeWarnings } from "./normalize.ts";
import { failure, type ImportDeps, type ImportResult } from "./schema.ts";
import { runExtraction } from "./text.ts";

const MAX_IMAGES = 4;
/** Base64 characters per image. The API accepts 5 MB of image data, which is about 6.9 M characters. */
const MAX_IMAGE_CHARS = 6_900_000;
const MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/** Fewer ingredients than this, or no steps, is a partial reading worth a second opinion. */
const MIN_INGREDIENTS_FOR_FULL_READING = 2;

export async function importFromImage(
  images: readonly ExtractImage[],
  deps: ImportDeps = {},
): Promise<ImportResult> {
  if (images.length === 0 || images.length > MAX_IMAGES) {
    return failure("invalid_request", `Send between 1 and ${MAX_IMAGES} photos.`);
  }
  for (const image of images) {
    if (!MEDIA_TYPES.has(image.mediaType) || image.data.length === 0) {
      return failure("invalid_request", "That photo format is not supported.");
    }
    if (image.data.length > MAX_IMAGE_CHARS) {
      return failure("too_large", "That photo is too large to read.");
    }
  }

  const first = await runExtraction(deps, { source: "photo", text: "", images });
  if (!first.ok) return first;
  if (!first.output.found) {
    return failure("no_recipe_found", "We could not find a recipe in that photo.");
  }

  const partial =
    first.output.ingredients.length < MIN_INGREDIENTS_FOR_FULL_READING ||
    first.output.steps.length === 0;
  const warnings: string[] = [];
  let output = first.output;

  if (partial) {
    const second = await runExtraction(deps, {
      source: "photo",
      text: "",
      images,
      model: MODELS.opus,
    });
    if (second.ok && second.output.found) {
      warnings.push("escalated_to_opus");
      // Keep whichever reading captured more of the card.
      const size = (o: typeof output) => o.ingredients.length + o.steps.length;
      if (size(second.output) > size(output)) output = second.output;
    }
  }

  const recipe = normalizeModelOutput(output);
  if (!recipe) return failure("no_recipe_found", "We could not find a recipe in that photo.");
  return {
    ok: true,
    recipe,
    path: "vision",
    warnings: [...warnings, ...recipeWarnings(recipe)],
  };
}
