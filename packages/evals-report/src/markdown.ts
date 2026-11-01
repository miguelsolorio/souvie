// The summary printed to the console, written to the job summary, and posted on the pull request.
import type { Evaluation } from "./compare.ts";

/** Marks the comment this workflow owns, so a new run edits it instead of adding another. */
export const COMMENT_MARKER = "<!-- souvie-evals -->";

export interface ReportMeta {
  /** The vitest exit code. */
  vitestExit: number;
  tests: { total: number; passed: number; failed: number; skipped: number } | null;
  /** Where the baseline came from, for the footer. */
  baselineSource: string;
  suites: string[] | null;
  live: boolean;
}

const pct = (value: number) => `${value.toFixed(1)}%`;

function deltaText(delta: number | null): string {
  if (delta === null) return "n/a";
  if (Math.abs(delta) < 0.05) return "0.0";
  return `${delta > 0 ? "+" : ""}${delta.toFixed(1)}`;
}

/** Markdown with a table of every score and the reasons a run failed. */
export function renderMarkdown(evaluation: Evaluation, meta: ReportMeta): string {
  const lines = [
    COMMENT_MARKER,
    `### Evals: ${evaluation.ok && meta.vitestExit === 0 ? "pass" : "FAIL"}`,
    "",
    "| Suite | Metric | Score | Passed | Threshold | Baseline | Change | |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const v of evaluation.verdicts) {
    lines.push(
      `| ${v.suite} | ${v.metric} | ${pct(v.value)} | ${v.passed}/${v.total} | ${
        v.threshold === null ? "none" : pct(v.threshold)
      } | ${v.baseline === null ? "none" : pct(v.baseline)} | ${deltaText(v.delta)} | ${
        v.status === "fail" ? "FAIL" : v.status === "new" ? "new" : "ok"
      } |`,
    );
  }
  if (evaluation.verdicts.length === 0)
    lines.push("| (no scores were reported) | | | | | | | FAIL |");

  const problems = [
    ...evaluation.failures,
    ...(meta.vitestExit !== 0 ? [`vitest exited with ${meta.vitestExit}`] : []),
  ];
  if (problems.length > 0) {
    lines.push("", "**Why it failed**", "", ...problems.map((p) => `- ${p}`));
  }
  const counts = meta.tests
    ? ` ${meta.tests.passed} of ${meta.tests.total} tests passed, ${meta.tests.failed} failed, ${meta.tests.skipped} skipped.`
    : "";
  lines.push(
    "",
    `<sub>${meta.live ? "Live run (models called). " : "Offline run: recorded model answers only. "}${
      meta.suites ? `Suites: ${meta.suites.join(", ")}. ` : ""
    }Baseline: ${meta.baselineSource}. A score may fall 2 points below it.${counts}</sub>`,
  );
  return `${lines.join("\n")}\n`;
}
