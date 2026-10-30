// The fixtures are checked into a public repo, so this guard runs with `pnpm test` and in CI:
// no fixture may hold anyone's prose (docs/06-risks.md R5, docs/05-security-privacy.md).
//
//   * a JSON-LD fixture must be exactly what redact.ts produces: facts and "Step N." placeholders
//   * a fixture with real text must belong to a case that names an open license, and the license
//     and credit line must be in fixtures/index.json
//   * nothing else in the fixtures folder

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";
import { findJsonLdRecipe } from "../src/html.ts";
import { instructionGroups } from "../src/jsonld.ts";
import { FIXTURE_DIR, readHtml, readIndex } from "./fixtures.ts";
import { redactRecipePage } from "./redact.ts";
import type { Case } from "./score.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const cases = (JSON.parse(readFileSync(join(HERE, "urls.json"), "utf8")) as { cases: Case[] })
  .cases;
const index = readIndex();

/** About 20 KB, per the evidence round. A redacted fixture is a few kilobytes. */
const MAX_REDACTED_BYTES = 20_000;

describe("fixtures hold no third-party prose", () => {
  it("has one page and one index entry per case, and nothing else", () => {
    const files = readdirSync(FIXTURE_DIR)
      .filter((f) => f.endsWith(".html"))
      .map((f) => f.replace(/\.html$/, ""))
      .sort();
    expect(files).toEqual(cases.map((c) => c.id).sort());
    expect(Object.keys(index).sort()).toEqual(cases.map((c) => c.id).sort());
  });

  it("requires an open license for every case the model path reads", () => {
    for (const c of cases.filter((x) => x.expectPath === "llm")) {
      expect(c.license, `${c.id} needs a license`).toBeDefined();
      expect(c.license?.name, c.id).toMatch(/^CC |public domain/i);
      expect(c.license?.url, c.id).toMatch(/^https:\/\//);
      expect(c.license?.attribution, c.id).toContain(c.url);
    }
  });

  for (const c of cases) {
    const meta = index[c.id];

    if (c.license) {
      it(`${c.id}: real text, recorded under ${c.license.name} with its credit line`, () => {
        expect(meta?.kind).toBe("licensed");
        expect(meta?.license).toBe(c.license?.name);
        expect(meta?.licenseUrl).toBe(c.license?.url);
        expect(meta?.attribution).toBe(c.license?.attribution);
        // The page itself declares the license it was recorded under.
        const html = readHtml(c.id) ?? "";
        expect(html).toContain('rel="license"');
        expect(findJsonLdRecipe(cheerio.load(html))).toBeNull();
      });
    } else {
      it(`${c.id}: facts only, step text is a placeholder`, () => {
        const html = readHtml(c.id);
        expect(html, "fixture missing").not.toBeNull();
        expect(meta?.kind).toBe("redacted");
        expect(html?.length).toBeLessThanOrEqual(MAX_REDACTED_BYTES);
        // Exactly the redactor's output: no body, no description, no image, no prose.
        expect(redactRecipePage(html ?? "")).toBe(html);
        const recipe = findJsonLdRecipe(cheerio.load(html ?? ""));
        const steps = (instructionGroups(recipe ?? {}) ?? []).flatMap((g) =>
          g.items.map((i) => i.value),
        );
        expect(steps.length).toBeGreaterThan(0);
        expect(steps.every((s, i) => s === `Step ${i + 1}.`)).toBe(true);
      });
    }
  }
});
