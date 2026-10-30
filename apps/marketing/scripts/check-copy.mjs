#!/usr/bin/env node
// Copy compliance gate for the marketing site and the store listing (WS14).
//
//   node apps/marketing/scripts/check-copy.mjs               scan the shipped copy
//   node apps/marketing/scripts/check-copy.mjs --file a.txt  scan one file as site copy
//
// Exit 0 when clean, 1 when a rule fails. Wired into `pnpm lint`.
//
// Why these rules (docs/04-integrations.md compliance checklists, docs/08-brand.md §10):
//   - Instacart's developer terms ban calling them a partner and the words "Free Delivery".
//   - Kroger's terms ban "Kroger" in the app name and any implied endorsement, so it must not
//     appear in a title, heading, or logo text.
//   - No retailer logos on marketing pages (Kroger allows banner logos only inside the
//     add-to-cart UI of a non-monetized app).
//   - v1 is non-commercial: no prices, plans, or subscription language (docs/06 R22).
//   - House style: no em dashes.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// CHECK_COPY_ROOT points the script at another tree. The tests use it to build fixtures.
const repoRoot = process.env.CHECK_COPY_ROOT
  ? resolve(process.env.CHECK_COPY_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const siteDirs = ["apps/marketing/src", "apps/marketing/public"].map((dir) => join(repoRoot, dir));
const logoDirs = [...siteDirs, join(repoRoot, "apps/marketing/src/assets")];
const docPath = join(repoRoot, "docs/08-brand.md");

const TEXT_EXTENSIONS = new Set([
  ".astro",
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".md",
  ".mdx",
  ".html",
  ".svg",
  ".txt",
  ".json",
]);
const RETAILERS = "kroger|qfc|fred[-_ ]?meyer|safeway|albertsons|haggen|costco|instacart";
const COPY_BLOCK = /<!--\s*copy:start\s*-->([\s\S]*?)<!--\s*copy:end\s*-->/g;

/** @typedef {{ file: string, line: number, rule: string, message: string }} Problem */

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

/** Positions of every match of `pattern` (global) in `text`. */
function positions(text, pattern) {
  return [...text.matchAll(pattern)].map((match) => match.index ?? 0);
}

/**
 * Rules that apply to any copy: the site's source files and the listing blocks in the docs.
 * `text` is the raw file text, `offsetLine` shifts line numbers for blocks inside a doc.
 * @returns {Omit<Problem, "file">[]}
 */
function checkCopy(text, offsetLine = 0) {
  /** @type {Omit<Problem, "file">[]} */
  const problems = [];
  const add = (index, rule, message) =>
    problems.push({ line: lineOf(text, index) + offsetLine, rule, message });

  // Never call Instacart a partner. "Near" means within 80 characters, either order.
  const instacart = positions(text, /instacart/gi);
  const partner = positions(text, /partner\w*/gi);
  for (const a of instacart) {
    if (partner.some((b) => Math.abs(a - b) <= 80)) {
      add(
        a,
        "instacart-partner",
        'Never call Instacart a partner ("partner" within 80 characters of "Instacart").',
      );
    }
  }

  for (const index of positions(text, /free[\s_-]*delivery/gi)) {
    add(index, "free-delivery", 'Never write "Free Delivery" (Instacart terms).');
  }

  for (const index of positions(text, /—/g)) {
    add(index, "em-dash", "No em dashes. Use a period, a colon, or reorder.");
  }

  // v1 is non-commercial: no prices, no plans.
  for (const index of positions(text, /\$\s?\d/g)) {
    add(
      index,
      "pricing",
      "No prices in marketing or listing copy (v1 is non-commercial, docs/06 R22).",
    );
  }
  const plans = [
    ...positions(text, /\b(?:subscriptions?|per month|pricing|premium)\b|\/month/gi),
    ...positions(text, /\bPro\b/g),
  ];
  for (const index of plans) {
    add(
      index,
      "pricing",
      "No pricing, Pro, or subscription language (v1 is non-commercial, docs/06 R22).",
    );
  }

  return problems;
}

/** Snippets of `text` where a name or title lives, so "Kroger" there is an error. */
function titleSnippets(text) {
  /** @type {{ index: number, text: string }[]} */
  const out = [];
  const grab = (pattern, group = 1) => {
    for (const match of text.matchAll(pattern))
      out.push({ index: match.index ?? 0, text: match[group] ?? "" });
  };
  grab(/<title[^>]*>([\s\S]*?)<\/title>/gi);
  grab(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi);
  grab(/<text[^>]*>([\s\S]*?)<\/text>/gi);
  grab(/<meta[^>]+(?:title|application-name)[^>]*content=["']([^"']*)["']/gi);
  // Config and script strings: `name: "..."`, `title: "..."`, `headline: "..."`.
  grab(/\b(?:name|title|headline|appName)\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/gi);
  return out;
}

/** @returns {Omit<Problem, "file">[]} */
function checkSiteFile(text) {
  const problems = checkCopy(text);
  for (const snippet of titleSnippets(text)) {
    if (/kroger/i.test(snippet.text)) {
      problems.push({
        line: lineOf(text, snippet.index),
        rule: "kroger-title",
        message:
          'Never use "Kroger" in a title, heading, name, or logo text (Kroger terms: no endorsement, not in the app name).',
      });
    }
  }
  const logoRef = new RegExp(
    `<(?:img|image|source)[^>]+(?:src|href|srcset)=["'][^"']*(?:${RETAILERS})[^"']*["']`,
    "gi",
  );
  for (const index of positions(text, logoRef)) {
    problems.push({
      line: lineOf(text, index),
      rule: "retailer-logo",
      message: "No retailer logos on marketing pages. Use the store name as text.",
    });
  }
  return problems;
}

/** Listing copy in the docs: lines that name a title or heading get the Kroger-in-title rule. */
function checkDocBlock(block, blockStartLine) {
  const problems = checkCopy(block, blockStartLine);
  const lines = block.split("\n");
  lines.forEach((line, i) => {
    const isTitleLine =
      /^\s*(?:[-*]\s*)?\*\*(?:title|subtitle|short description|app name|headline)\b/i.test(line) ||
      /^\s*#{1,6}\s/.test(line);
    if (isTitleLine && /kroger/i.test(line)) {
      problems.push({
        line: blockStartLine + i + 1,
        rule: "kroger-title",
        message: 'Never use "Kroger" in a title, subtitle, or heading.',
      });
    }
  });
  return problems;
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** @type {Problem[]} */
const problems = [];
const report = (file, found) => {
  for (const problem of found)
    problems.push({ file: relative(repoRoot, file) || file, ...problem });
};

const args = process.argv.slice(2);
const fileFlags = args.flatMap((arg, i) =>
  arg === "--file" && args[i + 1] ? [resolve(args[i + 1])] : [],
);
let scanned = 0;
let blocks = 0;

if (fileFlags.length > 0) {
  for (const file of fileFlags) {
    report(file, checkSiteFile(readFileSync(file, "utf8")));
    scanned += 1;
  }
} else {
  for (const file of siteDirs.flatMap(walk)) {
    if (!TEXT_EXTENSIONS.has(extname(file))) continue;
    report(file, checkSiteFile(readFileSync(file, "utf8")));
    scanned += 1;
  }

  // No retailer logo files in the site's public or asset folders.
  const logoName = new RegExp(`(${RETAILERS})`, "i");
  for (const file of logoDirs.flatMap(walk)) {
    if (logoName.test(relative(repoRoot, file).split("/").slice(-1)[0] ?? "")) {
      report(file, [
        {
          line: 1,
          rule: "retailer-logo",
          message: "No retailer logo files under apps/marketing (public or src/assets).",
        },
      ]);
    }
  }

  if (existsSync(docPath)) {
    const doc = readFileSync(docPath, "utf8");
    for (const match of doc.matchAll(COPY_BLOCK)) {
      const start = lineOf(doc, match.index ?? 0);
      report(docPath, checkDocBlock(match[1] ?? "", start));
      blocks += 1;
    }
    if (blocks === 0) {
      report(docPath, [
        {
          line: 1,
          rule: "no-copy-blocks",
          message: "No <!-- copy:start --> blocks found, so no listing copy was checked.",
        },
      ]);
    }
  }
}

for (const p of problems) console.error(`${p.file}:${p.line}: [${p.rule}] ${p.message}`);
if (problems.length > 0) {
  console.error(`check-copy: ${problems.length} problem${problems.length === 1 ? "" : "s"}`);
  process.exit(1);
}
console.log(`check-copy: ok (${scanned} site files, ${blocks} doc copy blocks)`);
