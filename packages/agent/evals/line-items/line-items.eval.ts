// `pnpm eval` (WS15): the line-item golden set. 100 cases per retailer (kroger, safeway) against
// MockRetailer fixtures; at least 90 percent must pick the expected product or an accepted
// alternative (docs/03-ai-design.md §10, risks R1 and R13). Offline: MockRetailer is in memory.
//
// A failure here means the matcher picked a different product than a shopper would expect, or
// picked one where it should have picked nothing. Report it; do not tune the matcher to pass.
import { writeSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { recordScore } from "../../../evals-report/src/record.ts";
import { buildCases, formatRetailer, RETAILERS, runRetailer, unknownProductNames } from "./run.ts";

const THRESHOLD = 90;
const cases = buildCases();

function emit(text: string): void {
  writeSync(1, `${text}\n`);
}

describe("line-item golden set", () => {
  it("has 100 cases, each naming products the catalog has", () => {
    expect(cases).toHaveLength(100);
    expect(unknownProductNames(cases)).toEqual([]);
  });

  for (const setup of RETAILERS) {
    it(`${setup.id}: at least ${THRESHOLD}% pick the expected product or an accepted alternative`, async () => {
      const result = await runRetailer(setup, cases);
      emit(`\n${formatRetailer(result)}`);
      recordScore({
        suite: "lineItems",
        metric: setup.id,
        value: result.score,
        passed: result.passed,
        total: result.total,
        threshold: THRESHOLD,
      });
      recordScore({
        suite: "lineItems",
        metric: `${setup.id}_candidate_recall`,
        value: result.candidateRecall,
        passed: Math.round((result.candidateRecall / 100) * result.total),
        total: result.total,
        threshold: null,
      });
      expect(result.score).toBeGreaterThanOrEqual(THRESHOLD);
    });
  }
});
