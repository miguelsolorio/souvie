// Duplicate detection for added recipes (WS02 follow-up, 2026-10-31). Pure functions the
// recipe-import Edge Function and the app share, so "the same recipe" means the same thing in both:
//
//   normalizeSourceUrl   a recipe's link in comparison form (lowercase host, no fragment, no
//                        tracking parameters, no trailing slash). The SQL twin is
//                        public.normalize_source_url in
//                        supabase/migrations/20261031130000_recipes_source_url_normalized.sql, which
//                        fills recipes.source_url_normalized; the two are tested against one list of
//                        links (supabase/functions/recipe-import/migration.test.ts).
//   normalizeTitle       a title with case and spacing folded, for recipes that have no link
//   titleSearchPattern   an ilike pattern that finds every title normalizeTitle could equal
//
// No `URL` class on purpose: React Native's is partial, and this file also runs in the app. It
// imports nothing, so the app reaches it through "@mp/recipe-import/dedupe" without pulling the
// scrapers or the Anthropic SDK into the bundle.

/**
 * Query parameters that say who shared a link, not what it points to. `cleanSourceUrl` (normalize.ts)
 * strips the same list from the link a recipe is stored with; the SQL function has a copy.
 */
export const TRACKING_PARAM =
  /^(utm_[a-z_]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|igsh|ref_src|_ga|oly_[a-z_]+)$/i;

const LINK = /^(https?):\/\/([^/?#\s]*)([^?#\s]*)(?:\?([^#\s]*))?(?:#.*)?$/i;

/**
 * The comparison form of an http(s) link, or null when it is not one. In order:
 *   1. trim, drop everything from the first "#"
 *   2. lowercase the scheme and the host (with any port or credentials)
 *   3. drop query parameters named like tracking ones (utm_*, fbclid, gclid, ...) and empty ones
 *   4. strip trailing slashes from the path; the path keeps its case, and what is left of the
 *      query keeps its order
 *
 * `https://Example.com/R/?utm_source=x#top` and `https://example.com/R` are the same recipe.
 * `https://example.com/r` is not: paths are case sensitive.
 */
export function normalizeSourceUrl(raw: string): string | null {
  const match = LINK.exec(raw.trim());
  if (!match) return null;
  const scheme = match[1] ?? "";
  const authority = match[2] ?? "";
  const path = match[3] ?? "";
  const kept = (match[4] ?? "")
    .split("&")
    .filter((piece) => piece !== "" && !TRACKING_PARAM.test(piece.split("=")[0] ?? ""));
  return (
    `${scheme.toLowerCase()}://${authority.toLowerCase()}${path.replace(/\/+$/, "")}` +
    (kept.length > 0 ? `?${kept.join("&")}` : "")
  );
}

/** Case and spacing folded: "  Lemon   CHICKEN " and "lemon chicken" are the same title. */
export function normalizeTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * An `ilike` pattern that matches every stored title whose normalizeTitle equals the one given: the
 * words in order with anything between them, starting and ending with them (a stored title is
 * trimmed, so there is no wildcard at either end). It over-matches (`lemon%chicken` also finds
 * "Lemon roast chicken"), so a caller compares the candidates with normalizeTitle afterwards.
 * `%`, `_` and `\` in the title are escaped.
 */
export function titleSearchPattern(title: string): string {
  const words = normalizeTitle(title)
    .split(" ")
    .filter((word) => word.length > 0)
    .map((word) => word.replace(/[\\%_]/g, "\\$&"));
  return words.join("%");
}
