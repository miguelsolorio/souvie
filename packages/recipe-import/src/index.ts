// @mp/recipe-import: URL, text, photo, or caption to a normalized recipe (WS02).
//
//   importFromUrl(url, deps)             fetch, scrapers, then Sonnet on the page text
//   importFromHtml(html, url, deps)      the same, for a page already in hand (evals, WS15)
//   importFromText(text, deps)           pasted text, Sonnet
//   importFromImage(images, deps)        photos of a recipe card, Claude vision
//   importFromCaption(caption, deps)     share-sheet caption text, Sonnet; never fetches
//   normalizeSourceUrl, normalizeTitle, dedupeIngredientLines   "is it the same recipe" (dedupe.ts)
//
// Each returns an `ImportResult`: `{ ok: true, recipe, path, warnings }` or
// `{ ok: false, reason, message }`. The model is optional (`deps.extract`); without it only the
// scrapers work. Relative imports carry the .ts extension so Supabase Edge Functions (Deno) can
// load this package by path. See README.md.
export const packageName = "@mp/recipe-import";

export * from "./caption.ts";
export * from "./dedupe.ts";
export { hasJsonLdRecipe, looksLikeChallenge, pageImage, readableText } from "./html.ts";
export { importFromImage } from "./image.ts";
export * from "./normalize.ts";
export * from "./schema.ts";
export * from "./share.ts";
export { importFromText } from "./text.ts";
export {
  checkUrl,
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  DESKTOP_USER_AGENT,
  fetchPage,
  importFromHtml,
  importFromUrl,
  isPrivateHost,
} from "./url.ts";
