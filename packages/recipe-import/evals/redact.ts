// Turns a fetched recipe page into a test fixture that holds facts and no one else's prose (WS02).
//
// docs/06-risks.md R5 and docs/05-security-privacy.md: the repo is public, so it must not
// republish scraped content. Instruction prose, descriptions, and images are copyrightable.
// Ingredient lists, quantities, times, and yields are facts. A fixture therefore keeps only what
// the importer reads and the scorer checks:
//
//   * <title>, the canonical link, and og:title
//   * one JSON-LD Recipe with: name, recipeIngredient, recipeYield, prepTime, cookTime, totalTime,
//     and a placeholder author (a few site scrapers throw without one; no importer output uses it)
//   * recipeInstructions with the same number of steps (and sections), every step "Step N."
//
// Everything else is dropped: the body, descriptions, images, authors, keywords, nutrition,
// comments, reviews, and videos. `redactRecipePage` is deterministic, so a refresh reproduces the
// same bytes from the same page. `eval:live` and `record-deno.ts` both run it before anything is
// written, and `sameImport` proves it changed nothing the importer sees.
//
// Pages with no JSON-LD Recipe cannot be redacted this way, because the model path needs their
// real text. Those are recorded only when the case names an open license (see `urls.json`).

import * as cheerio from "cheerio";
import { findJsonLdRecipe } from "../src/html.ts";
import { instructionGroups } from "../src/jsonld.ts";
import type { ImportResult } from "../src/schema.ts";

/** ISO 8601 durations only ("PT1H30M", "P0DT45M"). Anything else is dropped. */
const DURATION = /^P(?:\d+[YMWD])*(?:T(?:\d+[HMS])+)?$/i;
const MAX_FIELD = 200;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function oneLine(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_FIELD);
}

function yieldOf(value: unknown): string | number | string[] | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string") return oneLine(value) || undefined;
  if (Array.isArray(value)) {
    const items = value
      .flat(1)
      .filter((v): v is string | number => typeof v === "string" || typeof v === "number")
      .map((v) => oneLine(String(v)))
      .filter(Boolean);
    return items.length > 0 ? items : undefined;
  }
  return undefined;
}

/** The Recipe node reduced to facts. Step text is "Step N." and section names are "Section N.". */
function factsOf(recipe: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Recipe",
    author: { "@type": "Person", name: "Author" },
  };

  if (typeof recipe.name === "string") out.name = oneLine(recipe.name);

  const ingredients = Array.isArray(recipe.recipeIngredient)
    ? recipe.recipeIngredient
        .flat(2)
        .filter((line): line is string => typeof line === "string")
        .map((line) => line.replace(/\s+/g, " ").trim())
    : [];
  if (ingredients.length > 0) out.recipeIngredient = ingredients;

  const servings = yieldOf(recipe.recipeYield);
  if (servings !== undefined) out.recipeYield = servings;

  for (const key of ["prepTime", "cookTime", "totalTime"] as const) {
    const value = recipe[key];
    if (typeof value === "string" && DURATION.test(value.trim())) out[key] = value.trim();
  }

  // The same steps and sections the importer reads (jsonld.ts), counted the same way.
  const groups = instructionGroups(recipe);
  if (groups) {
    let step = 0;
    let section = 0;
    const howToStep = () => ({ "@type": "HowToStep", text: `Step ${++step}.` });
    const loose: unknown[] = [];
    const sections: unknown[] = [];
    for (const group of groups) {
      const steps = group.items.map(howToStep);
      if (group.name === null) loose.push(...steps);
      else {
        sections.push({
          "@type": "HowToSection",
          name: `Section ${++section}.`,
          itemListElement: steps,
        });
      }
    }
    out.recipeInstructions = [...loose, ...sections];
  }
  return out;
}

/**
 * The redacted fixture for a page, or null when the page has no JSON-LD Recipe (nothing to
 * redact to: see the note at the top of this file).
 */
export function redactRecipePage(html: string): string | null {
  const $ = cheerio.load(html);
  const recipe = findJsonLdRecipe($);
  if (!recipe) return null;

  const title = oneLine($("title").first().text());
  const canonical = $('link[rel="canonical"]').first().attr("href")?.trim();
  const ogTitle = oneLine($('meta[property="og:title"]').first().attr("content"));
  // "<" is escaped so the data can never close its own <script>.
  const json = JSON.stringify(factsOf(recipe)).replace(/</g, "\\u003c");

  const head = [
    '<meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title>`,
    canonical ? `<link rel="canonical" href="${escapeHtml(canonical)}">` : "",
    ogTitle ? `<meta property="og:title" content="${escapeHtml(ogTitle)}">` : "",
    `<script type="application/ld+json">${json}</script>`,
  ].filter(Boolean);

  return [
    "<!doctype html>",
    "<!-- Test fixture (WS02 evals/redact.ts): the recipe's facts only. Step text is replaced by placeholders. -->",
    '<html lang="en">',
    "<head>",
    ...head,
    "</head>",
    "<body></body>",
    "</html>",
    "",
  ].join("\n");
}

/** What a score cares about, for comparing two imports of the same recipe. */
export interface ImportShape {
  ok: boolean;
  /** "jsonld", "scraper", "llm", or the failure reason. */
  path: string;
  title?: string;
  ingredients?: number;
  steps?: number;
}

export function shapeOf(result: ImportResult): ImportShape {
  return result.ok
    ? {
        ok: true,
        path: result.path,
        title: result.recipe.title,
        ingredients: result.recipe.ingredients.length,
        steps: result.recipe.instructions.length,
      }
    : { ok: false, path: result.reason };
}

/**
 * True when a redacted or slimmed page imports like the original: same path, title, ingredient
 * count, and step count. Step text differs by design, so it is not compared.
 */
export function sameImport(full: ImportResult, reduced: ImportResult): boolean {
  return JSON.stringify(shapeOf(full)) === JSON.stringify(shapeOf(reduced));
}
