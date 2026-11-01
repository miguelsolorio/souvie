// `pnpm eval suggest`. The report and the cases are in run.ts. The gate here:
//   * any hard-filter violation fails (WS06 criterion 10: the threshold is zero)
//   * any disagreement between the SQL filters and the TypeScript re-check fails
//   * any missed mustExclude, mustInclude, or minCandidates fails
//   * a live case that ran and failed fails; a pending live case fails only when
//     SUGGEST_EVAL_REQUIRE_LIVE=1
import { writeSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { recordScore } from "../../../evals-report/src/record.ts";
import { formatReport, runSuggestEval } from "./run.ts";

const LIVE = process.env.EVAL_LIVE === "1";
const REQUIRE_LIVE = process.env.SUGGEST_EVAL_REQUIRE_LIVE === "1";

describe("suggest eval", () => {
  it("applies every household's hard filters with zero violations", async () => {
    const report = await runSuggestEval({
      live: LIVE,
      anthropicKey: process.env.ANTHROPIC_API_KEY?.trim() || undefined,
      voyageKey: process.env.VOYAGE_API_KEY?.trim() || undefined,
    });
    // Straight to stdout, so the report shows under any Vitest reporter.
    writeSync(1, `${formatReport(report)}\n`);
    // WS15: the score `pnpm eval` compares with the baseline (the threshold is zero violations).
    const clean = report.households.filter(
      (h) => h.violations.length + h.disagreements.length + h.expectationFailures.length === 0,
    ).length;
    recordScore({
      suite: "suggest",
      metric: "households_clean",
      value: (clean / Math.max(report.households.length, 1)) * 100,
      passed: clean,
      total: report.households.length,
      threshold: 100,
    });

    expect(report.households).toHaveLength(10);
    expect(report.violations).toBe(0);
    expect(report.disagreements).toBe(0);
    expect(report.expectationFailures).toBe(0);
    expect(report.live.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail}`)).toEqual([]);
    if (REQUIRE_LIVE) expect(report.pending.map((p) => p.name)).toEqual([]);
  }, 120_000);
});
