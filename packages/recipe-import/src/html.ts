// HTML helpers for the URL path (WS02): is there a JSON-LD recipe, what is the readable text of
// the page for the model, which image represents it, and is the page a bot-check wall instead of
// a recipe. All of it runs on a cheerio document the caller builds once.

import type { CheerioAPI } from "cheerio";
import { cleanImageUrl } from "./normalize.ts";

/** Characters of page text sent to the model. About 6,000 tokens. */
export const MAX_PAGE_TEXT = 24_000;

function isRecipeNode(node: unknown): node is Record<string, unknown> {
  if (!node || typeof node !== "object") return false;
  const type = (node as { "@type"?: unknown })["@type"];
  if (typeof type === "string") return type.toLowerCase() === "recipe";
  return (
    Array.isArray(type) && type.some((t) => typeof t === "string" && t.toLowerCase() === "recipe")
  );
}

function findRecipeNode(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 6 || !value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRecipeNode(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (isRecipeNode(value)) return value;
  const record = value as Record<string, unknown>;
  return (
    findRecipeNode(record["@graph"], depth + 1) ?? findRecipeNode(record.mainEntity, depth + 1)
  );
}

function jsonLdBlocks($: CheerioAPI): string[] {
  const blocks: string[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el)
      .text()
      .replace(/^\s*(?:\/\/\s*)?<!\[CDATA\[/, "")
      .replace(/\]\]>\s*$/, "")
      .trim();
    if (raw) blocks.push(raw);
  });
  return blocks;
}

/** The first schema.org Recipe node in the page's JSON-LD, or null. */
export function findJsonLdRecipe($: CheerioAPI): Record<string, unknown> | null {
  for (const raw of jsonLdBlocks($)) {
    try {
      const node = findRecipeNode(JSON.parse(raw));
      if (node) return node;
    } catch {
      // Malformed JSON-LD is common; hasJsonLdRecipe still notices a Recipe in its text.
    }
  }
  return null;
}

/** The Recipe node's `recipeIngredient` lines as published, repeats included. */
export function jsonLdIngredientLines($: CheerioAPI): string[] | undefined {
  const list = findJsonLdRecipe($)?.recipeIngredient;
  if (!Array.isArray(list)) return undefined;
  const lines = list.flat(2).filter((line): line is string => typeof line === "string");
  return lines.length > 0 ? lines : undefined;
}

/** True when the page carries a schema.org Recipe in a JSON-LD script. */
export function hasJsonLdRecipe($: CheerioAPI): boolean {
  if (findJsonLdRecipe($)) return true;
  return jsonLdBlocks($).some((raw) => /"@type"\s*:\s*(?:\[[^\]]*)?"Recipe"/.test(raw));
}

const REMOVE =
  "script, style, noscript, template, svg, iframe, canvas, form, button, nav, header, footer, aside, " +
  '[role="navigation"], [role="banner"], [role="contentinfo"], [aria-hidden="true"], ' +
  '#comments, .comments, .comment-list, .comments-area, [id^="comment"], [class*="comment-"], ' +
  '[class*="newsletter"], [class*="subscribe"], [class*="advert"], [class*="sidebar"], [class*="share-"], ' +
  '[class*="social"], [class*="related"], [class*="cookie"], [class*="popup"], [class*="modal"]';

const CONTENT_ROOTS = [
  '[itemtype*="schema.org/Recipe"]',
  ".wprm-recipe-container",
  ".tasty-recipes",
  "article",
  "main",
  '[role="main"]',
  ".entry-content",
  ".post-content",
  "#content",
  "#mw-content-text",
];

const BLOCKS =
  "p, li, h1, h2, h3, h4, h5, h6, div, section, tr, dt, dd, blockquote, pre, figcaption";

/** No-break space, zero-width space, and byte order mark. */
const INVISIBLE = /\u00a0|\u200b|\ufeff/g;

function linesOf(text: string): string[] {
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw
      .replace(INVISIBLE, " ")
      .replace(/[ \t]+/g, " ")
      .trim();
    if (line && line !== lines[lines.length - 1]) lines.push(line);
  }
  return lines;
}

/** One paragraph is never allowed to eat the whole budget. */
const MAX_LINE = 2_500;

/**
 * Keeps the part of long text around the ingredients heading, so a long story cannot push the
 * recipe out. Lines are cut to MAX_LINE first, so one huge paragraph cannot leave nothing.
 */
function fitToLimit(input: string[], limit: number): string[] {
  const lines = input.map((line) =>
    line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1)}…` : line,
  );
  const total = lines.reduce((sum, line) => sum + line.length + 1, 0);
  if (total <= limit) return lines;
  const heading = lines.findIndex(
    (line) => /^(?:ingredients?|what you.ll need|you will need)\b/i.test(line) && line.length < 60,
  );
  const start = Math.max(0, heading === -1 ? 0 : heading - 8);
  const out: string[] = [];
  let used = 0;
  for (const line of lines.slice(start)) {
    if (used + line.length + 1 > limit) break;
    out.push(line);
    used += line.length + 1;
  }
  return out;
}

/**
 * The readable text of a page: the recipe card or the main content, without navigation, comments,
 * or scripts, one line per block. Used as the model input when the scrapers find no recipe.
 * Mutates the document it is given, so pass a copy (`cheerio.load(html)`) not shared with
 * other readers.
 */
export function readableText($: CheerioAPI, limit = MAX_PAGE_TEXT): string {
  const title = $("title").first().text().replace(/\s+/g, " ").trim();
  $(REMOVE).remove();

  let root: ReturnType<CheerioAPI> = $("body");
  for (const selector of CONTENT_ROOTS) {
    const candidate = $(selector).first();
    if (candidate.length > 0 && candidate.text().replace(/\s+/g, " ").trim().length >= 200) {
      root = candidate;
      break;
    }
  }

  root.find("br").replaceWith("\n");
  root.find(BLOCKS).each((_, el) => {
    $(el).append("\n");
  });
  root.find("li").each((_, el) => {
    $(el).prepend("- ");
  });

  const lines = fitToLimit(linesOf(root.text()), limit);
  const body = lines.join("\n");
  return title && !body.includes(title) ? `Page title: ${title}\n\n${body}` : body;
}

/** The page's own preview image (Open Graph or Twitter card), as an absolute http(s) URL. */
export function pageImage($: CheerioAPI, pageUrl: string): string | undefined {
  const raw =
    $('meta[property="og:image"]').attr("content") ??
    $('meta[name="twitter:image"]').attr("content") ??
    $('meta[itemprop="image"]').attr("content");
  if (!raw) return undefined;
  try {
    return cleanImageUrl(new URL(raw, pageUrl).href);
  } catch {
    return cleanImageUrl(raw);
  }
}

const CHALLENGE_PATTERNS = [
  /just a moment\.\.\./i,
  /attention required!?\s*\|\s*cloudflare/i,
  /checking (?:if the site connection is secure|your browser)/i,
  /enable javascript and cookies to continue/i,
  /pardon our interruption/i,
  /access denied/i,
  /verify you are (?:a )?human/i,
  /please verify you are not a robot/i,
  /<title>\s*(?:403|forbidden|blocked)/i,
  /px-captcha|_incapsula_|captcha-delivery|challenge-platform/i,
];

/** True for the interstitial a bot-protection service serves instead of the page. */
export function looksLikeChallenge(html: string): boolean {
  // A real article is large. A challenge page is a few kilobytes at most.
  if (html.length > 60_000) return false;
  return CHALLENGE_PATTERNS.some((pattern) => pattern.test(html));
}
