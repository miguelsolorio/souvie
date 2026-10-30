// Scoring and report formatting for the URL golden set (WS02).
//
// A case passes when the title matches, the ingredient count is within one of the expected count,
// and there is at least the expected number of steps (docs/03-ai-design.md §10). The report has one
// line per case and a summary, in the format the brief specifies:
//
//   seriouseats.com   path=jsonld    PASS  title ok, 11/11 ingredients, 6 steps
//   paywalled.com     path=blocked   FAIL  403
//   SUMMARY 46/50 pass  (jsonld 39, llm 7, blocked 3, failed 1)

import type { NormalizedRecipe } from "@mp/core";

export interface Expectation {
  title: string;
  ingredients: number;
  minSteps: number;
  /** Optional ceiling that catches duplicated or label-only steps. */
  maxSteps?: number;
}

export type ExpectedPath = "jsonld" | "scraper" | "llm" | "blocked";

/** An open license that lets the repo keep a page's real text as a fixture. */
export interface License {
  /** For example "CC BY-SA 4.0". */
  name: string;
  url: string;
  /** The credit line the license asks for. */
  attribution: string;
}

export interface Case {
  id: string;
  url: string;
  expectPath: ExpectedPath;
  expect: Expectation;
  /** Required for a page with no JSON-LD recipe; see record.ts. */
  license?: License;
  /** `deno` for a site that refuses Node's fetch: record it with record-deno.ts. */
  recorder?: "deno";
}

export type Outcome =
  | {
      id: string;
      domain: string;
      path: "jsonld" | "scraper" | "llm";
      status: "PASS" | "FAIL";
      detail: string;
    }
  | { id: string; domain: string; path: "blocked" | "failed"; status: "FAIL"; detail: string }
  /** The case needs a model answer that is not recorded and no key is available to get one. */
  | { id: string; domain: string; path: "llm"; status: "PEND"; detail: string };

export function domainOf(url: string): string {
  return new URL(url).hostname.replace(/^www\./, "");
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/** The expected title's words all appear, in order, in the actual title (or the reverse). */
export function titleMatches(expected: string, actual: string): boolean {
  const inOrder = (needle: string[], haystack: string[]) => {
    let at = 0;
    for (const word of haystack) if (word === needle[at]) at++;
    return needle.length > 0 && at === needle.length;
  };
  const e = words(expected);
  const a = words(actual);
  return inOrder(e, a) || inOrder(a, e);
}

/**
 * True when the page text a model would read names the dish and lists ingredients: an
 * "Ingredients" heading, or at least half the expected number of list lines.
 */
export function pageTextCarriesRecipe(text: string, expect: Expectation): boolean {
  const haystack = words(text).join(" ");
  const nameOk = words(expect.title).every((w) => haystack.includes(w));
  const listLines = text.split("\n").filter((line) => line.startsWith("- ")).length;
  const listsIngredients =
    /ingredients?/i.test(text) || listLines >= Math.max(3, Math.floor(expect.ingredients / 2));
  return text.length >= 300 && nameOk && listsIngredients;
}

export function scoreRecipe(
  recipe: NormalizedRecipe,
  expect: Expectation,
): { pass: boolean; detail: string } {
  const titleOk = titleMatches(expect.title, recipe.title);
  const ingredientsOk = Math.abs(recipe.ingredients.length - expect.ingredients) <= 1;
  const stepsOk =
    recipe.instructions.length >= expect.minSteps &&
    (expect.maxSteps === undefined || recipe.instructions.length <= expect.maxSteps);
  const parts = [
    titleOk ? "title ok" : `title "${recipe.title}" does not match "${expect.title}"`,
    `${recipe.ingredients.length}/${expect.ingredients} ingredients`,
    `${recipe.instructions.length} steps`,
  ];
  return { pass: titleOk && ingredientsOk && stepsOk, detail: parts.join(", ") };
}

export function formatLine(outcome: Outcome): string {
  return `${outcome.domain.padEnd(30)} path=${outcome.path.padEnd(8)} ${outcome.status.padEnd(4)}  ${outcome.detail}`;
}

export interface Summary {
  total: number;
  pass: number;
  pending: number;
  failed: number;
  blocked: number;
  byPath: Record<"jsonld" | "scraper" | "llm", number>;
  line: string;
}

export function summarize(outcomes: readonly Outcome[]): Summary {
  const byPath = { jsonld: 0, scraper: 0, llm: 0 };
  let pass = 0;
  let pending = 0;
  let failed = 0;
  let blocked = 0;
  for (const o of outcomes) {
    if (o.status === "PASS") {
      pass++;
      byPath[o.path as "jsonld" | "scraper" | "llm"]++;
    } else if (o.status === "PEND") pending++;
    else if (o.path === "blocked") blocked++;
    else failed++;
  }
  const parts = [`jsonld ${byPath.jsonld}`];
  if (byPath.scraper > 0) parts.push(`scraper ${byPath.scraper}`);
  parts.push(`llm ${byPath.llm}`, `blocked ${blocked}`, `failed ${failed}`);
  if (pending > 0) parts.push(`pending ${pending}`);
  return {
    total: outcomes.length,
    pass,
    pending,
    failed,
    blocked,
    byPath,
    line: `SUMMARY ${pass}/${outcomes.length} pass  (${parts.join(", ")})`,
  };
}
