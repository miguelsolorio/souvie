// The gate: acceptance criterion 7. A score below its threshold, a score more than two points
// under the baseline from main, and a score that did not come back all fail the run.
import { describe, expect, it } from "vitest";
import {
  type Baseline,
  evaluate,
  keyOf,
  MAX_REGRESSION_POINTS,
  nextBaseline,
  parseBaseline,
  parseScores,
} from "./compare.ts";
import type { Score } from "./record.ts";

const score = (over: Partial<Score> = {}): Score => ({
  suite: "parser",
  metric: "qty_unit",
  value: 100,
  passed: 500,
  total: 500,
  threshold: 95,
  ...over,
});

const baseline = (scores: Record<string, number>): Baseline => ({
  updatedAt: "2026-10-31T00:00:00.000Z",
  scores: Object.fromEntries(
    Object.entries(scores).map(([key, value]) => [key, { value, passed: 0, total: 0 }]),
  ),
});

describe("evaluate", () => {
  it("passes a score at or above its threshold and within two points of the baseline", () => {
    const result = evaluate([score({ value: 99 })], baseline({ "parser/qty_unit": 100 }));
    expect(result.ok).toBe(true);
    expect(result.verdicts[0]).toMatchObject({ status: "pass", baseline: 100, delta: -1 });
  });

  it("fails a score below its threshold, with nothing to compare against", () => {
    const result = evaluate([score({ value: 94.8 })], null);
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(["parser/qty_unit: below the threshold of 95% (94.8%)"]);
  });

  it("fails a score that fell more than two points below the baseline although it is over its threshold", () => {
    const result = evaluate(
      [score({ metric: "ingredient_id", value: 96, threshold: 90 })],
      baseline({ "parser/ingredient_id": 99 }),
    );
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toMatch(/fell 3 points from the baseline 99%/);
  });

  it("allows exactly two points, and says how much it may fall", () => {
    expect(MAX_REGRESSION_POINTS).toBe(2);
    expect(
      evaluate([score({ value: 98, threshold: 90 })], baseline({ "parser/qty_unit": 100 })).ok,
    ).toBe(true);
    expect(
      evaluate([score({ value: 97.9, threshold: 90 })], baseline({ "parser/qty_unit": 100 })).ok,
    ).toBe(false);
    expect(
      evaluate([score({ value: 97.9, threshold: 90 })], baseline({ "parser/qty_unit": 100 }), {
        maxRegression: 5,
      }).ok,
    ).toBe(true);
  });

  it("calls a score the baseline does not know new, and passes it if it clears its threshold", () => {
    const result = evaluate([score({ metric: "extra" })], baseline({}));
    expect(result.verdicts[0]).toMatchObject({ status: "new", baseline: null, delta: null });
    expect(result.ok).toBe(true);
  });

  it("fails when a baseline score did not come back: a suite that stopped running is not a pass", () => {
    const result = evaluate(
      [score()],
      baseline({ "parser/qty_unit": 100, "lineItems/kroger": 99, "import/pass_rate": 100 }),
    );
    expect(result.missing).toEqual(["import/pass_rate", "lineItems/kroger"]);
    expect(result.ok).toBe(false);
    expect(result.failures).toContain(
      "lineItems/kroger: in the baseline but not reported by this run",
    );
  });

  it("with --suite, only that suite's baseline scores can be missing", () => {
    const result = evaluate(
      [score()],
      baseline({ "parser/qty_unit": 100, "lineItems/kroger": 99 }),
      { suites: ["parser"] },
    );
    expect(result.missing).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("ignores the threshold of an informational score but still compares it with the baseline", () => {
    const info = score({ metric: "candidate_recall", threshold: null, value: 90 });
    expect(evaluate([info], null).ok).toBe(true);
    expect(evaluate([info], baseline({ "parser/candidate_recall": 95 })).ok).toBe(false);
  });

  it("flags a score reported twice with different numbers, and accepts the same number twice", () => {
    expect(evaluate([score({ value: 99 }), score({ value: 98 })], null).conflicts).toEqual([
      "parser/qty_unit",
    ]);
    expect(evaluate([score(), score()], null).conflicts).toEqual([]);
  });

  it("sorts the verdicts by key", () => {
    const result = evaluate(
      [
        score({ suite: "lineItems", metric: "safeway" }),
        score({ suite: "import", metric: "pass_rate" }),
      ],
      null,
    );
    expect(result.verdicts.map((v) => v.key)).toEqual(["import/pass_rate", "lineItems/safeway"]);
  });
});

describe("the baseline file", () => {
  it("is written from the scores, rounded, sorted, and keeps other suites when one was run", () => {
    const previous = baseline({ "lineItems/kroger": 99, "parser/qty_unit": 100 });
    const next = nextBaseline(
      [score({ value: 99.4567, passed: 497, total: 500 })],
      previous,
      new Date("2026-11-02T10:00:00Z"),
      ["parser"],
    );
    expect(next.updatedAt).toBe("2026-11-02T10:00:00.000Z");
    expect(Object.keys(next.scores)).toEqual(["lineItems/kroger", "parser/qty_unit"]);
    expect(next.scores["parser/qty_unit"]).toEqual({ value: 99.46, passed: 497, total: 500 });
    expect(next.scores["lineItems/kroger"]).toEqual({ value: 99, passed: 0, total: 0 });
  });

  it("is replaced whole when every suite ran", () => {
    const previous = baseline({ "gone/metric": 100 });
    const next = nextBaseline([score()], previous, new Date("2026-11-02T10:00:00Z"));
    expect(Object.keys(next.scores)).toEqual(["parser/qty_unit"]);
  });

  it("parses, and refuses a file that is not a baseline", () => {
    expect(parseBaseline(JSON.stringify(baseline({ "a/b": 1 }))).scores["a/b"]?.value).toBe(1);
    expect(() => parseBaseline("{}")).toThrow(/updatedAt and scores/);
    expect(() => parseBaseline('{"updatedAt": "x", "scores": {"a/b": {}}}')).toThrow(
      /no numeric value/,
    );
  });
});

describe("parseScores", () => {
  it("reads the lines recordScore wrote, skipping blank ones", () => {
    const text = `${JSON.stringify(score())}\n\n${JSON.stringify(score({ metric: "b", threshold: null }))}\n`;
    expect(parseScores(text).map(keyOf)).toEqual(["parser/qty_unit", "parser/b"]);
  });

  it("names the line that is not a score", () => {
    expect(() => parseScores("not json")).toThrow("scores line 1 is not JSON");
    expect(() => parseScores(`${JSON.stringify(score())}\n{"suite": "x"}`)).toThrow(
      "scores line 2 is not a score",
    );
    expect(() => parseScores(JSON.stringify(score({ value: Number.NaN })))).toThrow("not a score");
  });
});
