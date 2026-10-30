// Golden-set eval for the ingredient parser (WS03). Run with `pnpm eval`.
//
// What it checks (docs/03-ai-design.md §10, WS03 brief acceptance criteria 3 to 5):
//   1. Deterministic path (grammar + lookup, no model, no network) on all golden lines:
//        qty and unit exact >= 95%, ingredientId right >= 90%, confidence >= 0.8 on >= 80% of lines.
//   2. Cache: a second pass over the same lines makes zero model calls. This uses a stand-in
//      model that answers from the golden labels, so it proves the batching and cache mechanics,
//      not model accuracy. Its accuracy numbers are never used for a threshold.
//   3. Live Haiku (only when ANTHROPIC_API_KEY is set): the full pipeline meets the same
//      thresholds, and a second pass makes zero calls through a cache persisted on disk.
//
// The golden labels are in lines.json: 500 lines, written by hand by the builder agent (Claude
// Sonnet 5.5), not by Opus and not spot-checked by a person. They cover US, Indian, Southeast and
// East Asian, Mexican, and Mediterranean recipes, abbreviations, unicode fractions, ranges,
// package sizes, 50 lines with no quantity, and 22 ingredients the seed lacks on purpose.
// The parser was tuned against this set, so its scores are in-sample. README.md records what the
// untouched first runs of the two blind tranches (178 lines) scored before any fix.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ingredientId, readSeed } from "../../../supabase/seed/load.ts";
import {
  type CachedParse,
  cacheKey,
  createAnthropicParseClient,
  InMemoryOntology,
  InMemoryParseCache,
  type LlmBatchResult,
  type LlmItem,
  type LlmParseClient,
  type ParserDeps,
  parseLinesGrouped,
} from "../src/index.ts";
import {
  describeFailure,
  formatReport,
  type GoldenLine,
  type LineScore,
  scoreLine,
  summarize,
} from "./score.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(join(HERE, "lines.json"), "utf8")) as GoldenLine[];
const seed = readSeed();
const ontology = new InMemoryOntology({
  ingredients: seed.ingredients.map((i) => ({
    ingredientId: i.id,
    name: i.name,
    category: i.category,
    plural: i.plural,
  })),
  aliases: seed.aliases,
});
const raws = golden.map((g) => g.raw);

async function score(deps: ParserDeps): Promise<LineScore[]> {
  const results = await parseLinesGrouped(raws, deps);
  return golden.map((line, i) => scoreLine(line, results[i] ?? [], ingredientId));
}

/** Answers from the golden labels. Counts calls so the cache can be audited. */
class StandInModel implements LlmParseClient {
  readonly model = "stand-in-from-golden-labels";
  readonly promptVersion = "stand-in";
  calls = 0;
  lines = 0;
  private readonly byKey = new Map(golden.map((g) => [cacheKey(g.raw), g]));

  async parseBatch(lines: readonly string[]): Promise<LlmBatchResult> {
    this.calls++;
    this.lines += lines.length;
    const byIndex = new Map<number, LlmItem[]>();
    lines.forEach((line, i) => {
      const hit = this.byKey.get(cacheKey(line));
      if (!hit) return;
      byIndex.set(
        i,
        hit.items.map((e) => ({
          qty: e.qty,
          qty_max: e.qtyMax,
          unit: e.unit,
          ingredient: e.ingredient,
          category: null,
          prep: e.prep,
          optional: e.optional,
          confidence: 0.9,
        })),
      );
    });
    return {
      byIndex,
      usage: {
        model: this.model,
        promptVersion: this.promptVersion,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        latencyMs: 0,
        ok: true,
        lines: lines.length,
      },
    };
  }
}

function printFailures(
  title: string,
  scores: readonly LineScore[],
  pick: (s: LineScore) => boolean,
): void {
  const failed = scores.filter((s) => !pick(s));
  if (failed.length === 0) return;
  console.log(`\n${title}: ${failed.length} line(s)`);
  for (const s of failed.slice(0, 60)) console.log(describeFailure(s));
}

describe("ingredient parser golden set", () => {
  it("has 500 labeled lines, with at least 50 that name no quantity", () => {
    expect(golden.length).toBe(500);
    const noQty = golden.filter((g) => g.items.every((i) => i.qty === null));
    expect(noQty.length).toBeGreaterThanOrEqual(50);
    expect(new Set(raws).size).toBe(raws.length);
  });

  it("deterministic path meets the thresholds with no model and no network", async () => {
    const scores = await score({ ontology });
    const report = summarize(scores);
    console.log(`\n${formatReport("Deterministic path (grammar + lookup, no model)", report)}`);
    printFailures("qty/unit mismatches", scores, (s) => s.qtyUnit);
    printFailures("ingredient mismatches", scores, (s) => s.ingredient);
    printFailures("below 0.8 confidence", scores, (s) => s.confident);

    expect(report.qtyUnit).toBeGreaterThanOrEqual(0.95);
    expect(report.ingredient).toBeGreaterThanOrEqual(0.9);
    expect(report.confident).toBeGreaterThanOrEqual(0.8);
    expect(report.grammarConfident).toBeGreaterThanOrEqual(0.8);
    // Errors that reach 0.8 confidence never go to the model, so they must stay rare (1%).
    expect(report.confidentWrong).toBeLessThanOrEqual(5);
  });

  it("makes zero model calls on a second pass (cache proof, stand-in model)", async () => {
    const cache = new InMemoryParseCache();
    const model = new StandInModel();
    const deps: ParserDeps = { ontology, cache, llm: model };

    const first = summarize(await score(deps));
    const callsFirst = model.calls;
    const linesFirst = model.lines;
    expect(callsFirst).toBeGreaterThan(0);
    expect(cache.size).toBeGreaterThan(0);

    const second = summarize(await score(deps));
    console.log(
      `\nCache proof (stand-in model, not an accuracy measure)\n` +
        `  pass 1: ${callsFirst} model calls, ${linesFirst} lines sent (batches of 20)\n` +
        `  pass 2: ${model.calls - callsFirst} model calls\n` +
        `  stage counts pass 1: grammar ${first.stageCounts.grammar}, lookup ${first.stageCounts.lookup}, llm ${first.stageCounts.llm}\n` +
        `  stage counts pass 2: grammar ${second.stageCounts.grammar}, lookup ${second.stageCounts.lookup}, llm ${second.stageCounts.llm}`,
    );
    expect(model.calls).toBe(callsFirst);
    expect(first.stageCounts.llm).toBeGreaterThan(0);
    expect(second.stageCounts.llm).toBe(first.stageCounts.llm);
    // Every request holds at most 20 lines.
    expect(Math.ceil(linesFirst / 20)).toBeLessThanOrEqual(callsFirst);
  });

  const live = process.env.ANTHROPIC_API_KEY ? it : it.skip;
  live(
    "live Haiku fallback meets the thresholds and the second pass is free",
    async () => {
      const cacheDir = join(HERE, ".cache");
      const cacheFile = join(cacheDir, "ingredient-parse.json");
      const cache = new InMemoryParseCache();
      if (existsSync(cacheFile)) {
        cache.load(JSON.parse(readFileSync(cacheFile, "utf8")) as [string, CachedParse][]);
      }
      const real = createAnthropicParseClient();
      let calls = 0;
      const counting: LlmParseClient = {
        model: real.model,
        promptVersion: real.promptVersion,
        async parseBatch(lines) {
          calls++;
          return real.parseBatch(lines);
        },
      };
      const deps: ParserDeps = { ontology, cache, llm: counting };

      const scores = await score(deps);
      const report = summarize(scores);
      console.log(
        `\n${formatReport("Live pipeline (grammar + lookup + Haiku)", report)}\n  model calls this pass: ${calls}`,
      );
      printFailures("live: qty/unit mismatches", scores, (s) => s.qtyUnit);
      printFailures("live: ingredient mismatches", scores, (s) => s.ingredient);
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(cache.entries()));

      const before = calls;
      await score(deps);
      expect(calls - before).toBe(0);
      expect(report.qtyUnit).toBeGreaterThanOrEqual(0.95);
      expect(report.ingredient).toBeGreaterThanOrEqual(0.9);
    },
    300_000,
  );
});
