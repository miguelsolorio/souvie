// Pure helpers the app imports as well as the importers (WS02): no cheerio, no model, no network.
//
//   * ingredientLikeLines / hasEnoughCaptionText: decide, before any request, whether a shared
//     caption has enough ingredient-like lines to be worth reading (acceptance criterion 7)
//   * isVideoPlatformUrl: the list of hosts we never fetch (R11)
//   * splitSharedText: a shared message into its caption text and its link
//
// The app reaches this file through "@mp/recipe-import/share", so importing it does not pull the
// scrapers or the Anthropic SDK into the bundle.

/** A caption needs at least this many ingredient-like lines to be worth a model call. */
export const MIN_INGREDIENT_LINES = 2;

const FRACTIONS = "¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞";
const NUMBER_WORDS = "a|an|one|two|three|four|five|six|seven|eight|nine|ten|half|couple|few";
const QUANTITY_START = new RegExp(
  `^(?:\\d+(?:[./]\\d+)?(?:\\s+\\d+/\\d+)?|[${FRACTIONS}]|\\d+\\s*[${FRACTIONS}]|(?:${NUMBER_WORDS})\\b)`,
  "iu",
);
const MEASURE =
  /\d\s*(?:cups?|c\b|tbsps?|tablespoons?|tsps?|teaspoons?|oz|ounces?|lbs?|pounds?|g\b|grams?|kg|kilos?|ml|l\b|liters?|litres?|cloves?|pinch(?:es)?|dash(?:es)?|cans?|sticks?|slices?|bunch(?:es)?|heads?|sprigs?)\b/iu;
const TIME_UNIT =
  /^\d+(?:[.,]\d+)?\s*(?:-\s*\d+\s*)?(?:min|mins|minutes?|hrs?|hours?|secs?|seconds?|days?|steps?)\b/iu;
const PHRASE =
  /\b(?:to taste|pinch of|dash of|handful of|splash of|drizzle of|salt (?:and|&) pepper|salt\/pepper|for (?:serving|garnish|frying))\b/iu;
const STEP_NUMBER = /^\d{1,2}\s*[.):]\s+\p{L}/u;
const HASHTAGS_ONLY = /^(?:[#@][\p{L}\p{N}_.]+\s*)+$/u;
const BULLET =
  /^(?:[\u2022\u25aa\u25cf\u25cb\u2023*\u2713\u2714\u2705-]|\u{1F538}|\u{1F539}|\u{1F536}|\u{1F537}|\u{1F4CC}|\u{1F449}|\u{1F447})+\ufe0f?\s*/u;

function stripDecoration(line: string): string {
  // Leading emoji, bullets, and symbols; "Ingredients:" style prefixes stay out of the way.
  return line.replace(/^[^\p{L}\p{N}]+/u, "").trim();
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * The lines of a caption that read like ingredient lines: they start with an amount, carry a
 * measure, or use a phrase like "to taste"; or they sit in a run of three or more short bulleted
 * lines (a list of ingredients without amounts). Numbered steps, hashtags, and times are not.
 */
export function ingredientLikeLines(caption: string): string[] {
  const lines = caption
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const hits = new Array<boolean>(lines.length).fill(false);
  const shortBullet = new Array<boolean>(lines.length).fill(false);

  lines.forEach((raw, i) => {
    if (HASHTAGS_ONLY.test(raw)) return;
    const bulleted = BULLET.test(raw) || /^[^\p{L}\p{N}]/u.test(raw);
    const line = stripDecoration(raw);
    if (!line || line.length > 140 || wordCount(line) > 16) return;
    if (STEP_NUMBER.test(line) || TIME_UNIT.test(line)) return;

    if (QUANTITY_START.test(line) && wordCount(line) >= 2) hits[i] = true;
    else if (MEASURE.test(line) || PHRASE.test(line)) hits[i] = true;
    else if (bulleted && wordCount(line) <= 5 && !/[.!?]$/.test(line) && !/^[#@]/.test(line)) {
      shortBullet[i] = true;
    }
  });

  // A run of three or more short bulleted lines is an ingredient list without amounts.
  let runStart = -1;
  for (let i = 0; i <= lines.length; i++) {
    if (i < lines.length && shortBullet[i]) {
      if (runStart === -1) runStart = i;
      continue;
    }
    if (runStart !== -1 && i - runStart >= 3) {
      for (let j = runStart; j < i; j++) hits[j] = true;
    }
    runStart = -1;
  }

  return lines.filter((_, i) => hits[i]).map(stripDecoration);
}

/** True when a caption has enough ingredient-like lines to try. */
export function hasEnoughCaptionText(caption: string): boolean {
  return ingredientLikeLines(caption).length >= MIN_INGREDIENT_LINES;
}

/** Hosts whose pages are videos. We never fetch them (R11); the share sheet gives us the caption. */
const VIDEO_HOSTS = [
  "instagram.com",
  "tiktok.com",
  "youtube.com",
  "youtu.be",
  "youtube-nocookie.com",
  "facebook.com",
  "fb.watch",
  "fb.com",
  "vimeo.com",
  "twitch.tv",
];

function hostMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/** True for an address on a video platform, including subdomains such as vm.tiktok.com. */
export function isVideoPlatformUrl(raw: string): boolean {
  try {
    const host = new URL(raw.trim()).hostname.toLowerCase().replace(/\.$/, "");
    return VIDEO_HOSTS.some((domain) => hostMatches(host, domain));
  } catch {
    return false;
  }
}

const LINK = /https?:\/\/[^\s<>"')\]]+/i;

/**
 * Splits what the share sheet hands over (often "Check out this reel https://...") into the text
 * without the link and the link itself. Trailing punctuation is not part of the link.
 */
export function splitSharedText(shared: string): { text: string; url: string | null } {
  const match = LINK.exec(shared);
  if (!match) return { text: shared.trim(), url: null };
  const url = match[0].replace(/[.,;:!?]+$/, "");
  const text = (shared.slice(0, match.index) + shared.slice(match.index + match[0].length))
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  return { text, url };
}
