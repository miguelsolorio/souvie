// How a golden-set eval reports its score (WS15). Each `*.eval.ts` already asserts its own
// threshold; `recordScore` also writes the number down, so `pnpm eval` can compare it with the
// baseline from main and put it in the report. With EVAL_SCORES_FILE unset (a bare `vitest run`)
// it does nothing.
//
//   recordScore({ suite: "parser", metric: "qty_unit", value: 100, passed: 500, total: 500, threshold: 95 });
//
// One JSON object per line, appended, so evals running in parallel workers do not collide.
import { appendFileSync } from "node:fs";

export interface Score {
  /** import, parser, lineItems, agentReplay, suggest. */
  suite: string;
  /** What was measured: qty_unit, ingredient_id, kroger, pass_rate. Unique within the suite. */
  metric: string;
  /** Percent, 0 to 100. */
  value: number;
  passed: number;
  total: number;
  /** The percent the metric must reach, or null for a number reported without a gate of its own. */
  threshold: number | null;
}

export function recordScore(score: Score, file: string | undefined = process.env.EVAL_SCORES_FILE) {
  if (!file) return;
  appendFileSync(file, `${JSON.stringify(score)}\n`);
}
