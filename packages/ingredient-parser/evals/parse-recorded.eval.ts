// The parser golden set with the model fallback in the loop (WS15), offline. parse.eval.ts scores
// the deterministic path; this scores the whole pipeline, grammar and lookup and then Haiku for
// the lines they are unsure of, with Haiku's answers replayed from evals/recordings/. A prompt
// change that makes Haiku worse shows up here in CI, without a key and without a network call.
//
//   pnpm eval --suite parser          replay (CI: EVAL_REQUIRE_RECORDINGS=1 fails on a missing recording)
//   pnpm eval --suite parser --live   call Haiku (needs ANTHROPIC_API_KEY) and re-record
//
// Thresholds are the same as the deterministic set: qty and unit exact on at least 95 percent of
// lines, canonical ingredient id on at least 90 (docs/03-ai-design.md §10).
import { readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ingredientId, readSeed } from "../../../supabase/seed/load.ts";
import { recordScore } from "../../evals-report/src/record.ts";
import {
  createAnthropicParseClient,
  InMemoryOntology,
  InMemoryParseCache,
  type LlmParseClient,
  parseLinesGrouped,
} from "../src/index.ts";
import { createRecordedClient, RECORDINGS_DIR } from "./recorded.ts";
import { formatReport, type GoldenLine, scoreLine, summarize } from "./score.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIVE = process.env.EVAL_LIVE === "1";
const REQUIRE_RECORDINGS = process.env.EVAL_REQUIRE_RECORDINGS === "1";

function emit(text: string): void {
  writeSync(1, `${text}\n`);
}

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

describe("ingredient parser golden set with recorded Haiku answers", () => {
  it("meets the thresholds with the model fallback replayed from recordings", async () => {
    const real: LlmParseClient | undefined = LIVE ? createAnthropicParseClient() : undefined;
    // The recorded client takes its model and prompt version from the real client's, which is
    // built without calling anything.
    const base = real ?? createAnthropicParseClient({ apiKey: "replay-only" });
    const llm = createRecordedClient(base, { live: real });

    const results = await parseLinesGrouped(
      golden.map((g) => g.raw),
      { ontology, cache: new InMemoryParseCache(), llm },
    );
    const scores = golden.map((line, i) => scoreLine(line, results[i] ?? [], ingredientId));
    const report = summarize(scores);
    emit(
      `\n${formatReport("With recorded Haiku answers (grammar + lookup + Haiku)", report)}\n  model calls ${llm.calls} (${LIVE ? `live, ${llm.written.length} recorded to ${RECORDINGS_DIR}` : "replayed"}), batches with no recording ${llm.missing.length}`,
    );

    recordScore({
      suite: "parser",
      metric: "qty_unit_with_model",
      value: report.qtyUnit * 100,
      passed: Math.round(report.qtyUnit * report.lines),
      total: report.lines,
      threshold: 95,
    });
    recordScore({
      suite: "parser",
      metric: "ingredient_id_with_model",
      value: report.ingredient * 100,
      passed: Math.round(report.ingredient * report.lines),
      total: report.lines,
      threshold: 90,
    });

    expect(report.qtyUnit).toBeGreaterThanOrEqual(0.95);
    expect(report.ingredient).toBeGreaterThanOrEqual(0.9);
    // A batch with no recording scored as if the model had failed. Offline that is a pending
    // case; in CI it is a failure, so the gate cannot pass on answers nobody recorded.
    if (REQUIRE_RECORDINGS) expect(llm.missing).toEqual([]);
    // The fallback is part of this suite: some lines must actually have gone to the model.
    if (!LIVE && llm.missing.length === 0) expect(llm.calls).toBeGreaterThan(0);
  }, 300_000);
});
