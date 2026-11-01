// The gate (WS15, docs/03-ai-design.md §10): a merge is blocked when any score is below its
// threshold, when any score fell more than two points below the baseline from main, or when a
// score the baseline knows did not come back at all (a suite that stopped running must not read as
// a pass). Pure functions: the files and the git calls are in cli.ts.
import type { Score } from "./record.ts";

/** A score may fall this many points below the baseline before the gate fails. */
export const MAX_REGRESSION_POINTS = 2;

export interface BaselineEntry {
  value: number;
  passed: number;
  total: number;
}

export interface Baseline {
  /** When the file was last written by `pnpm eval --update-baseline`. */
  updatedAt: string;
  scores: Record<string, BaselineEntry>;
}

export const keyOf = (score: Pick<Score, "suite" | "metric">) => `${score.suite}/${score.metric}`;

export type Status = "pass" | "fail" | "new";

export interface Verdict extends Score {
  key: string;
  baseline: number | null;
  /** value minus baseline, in points; null with no baseline. */
  delta: number | null;
  status: Status;
  reasons: string[];
}

export interface Evaluation {
  verdicts: Verdict[];
  /** Baseline entries whose score did not come back. */
  missing: string[];
  /** Scores recorded twice with different numbers. */
  conflicts: string[];
  failures: string[];
  ok: boolean;
}

const round = (value: number) => Math.round(value * 100) / 100;

export interface EvaluateOptions {
  maxRegression?: number;
  /** Only these suites were run: the baseline entries of other suites are not missing. */
  suites?: readonly string[] | undefined;
}

export function evaluate(
  scores: readonly Score[],
  baseline: Baseline | null,
  options: EvaluateOptions = {},
): Evaluation {
  const maxRegression = options.maxRegression ?? MAX_REGRESSION_POINTS;
  const byKey = new Map<string, Score>();
  const conflicts: string[] = [];
  for (const score of scores) {
    const key = keyOf(score);
    const earlier = byKey.get(key);
    if (earlier && Math.abs(earlier.value - score.value) > 1e-9) conflicts.push(key);
    byKey.set(key, score);
  }

  const verdicts: Verdict[] = [];
  for (const [key, score] of byKey) {
    const known = baseline?.scores[key] ?? null;
    const reasons: string[] = [];
    if (score.threshold !== null && score.value + 1e-9 < score.threshold) {
      reasons.push(`below the threshold of ${score.threshold}% (${round(score.value)}%)`);
    }
    const delta = known ? round(score.value - known.value) : null;
    if (known && delta !== null && delta < -maxRegression) {
      reasons.push(
        `fell ${round(-delta)} points from the baseline ${round(known.value)}% (the most allowed is ${maxRegression})`,
      );
    }
    verdicts.push({
      ...score,
      key,
      baseline: known ? known.value : null,
      delta,
      status: reasons.length > 0 ? "fail" : known ? "pass" : "new",
      reasons,
    });
  }
  verdicts.sort((a, b) => a.key.localeCompare(b.key));

  const wanted = options.suites ? new Set(options.suites) : null;
  const missing = Object.keys(baseline?.scores ?? {})
    .filter((key) => !byKey.has(key))
    .filter((key) => !wanted || wanted.has(key.split("/")[0] ?? ""))
    .sort();

  const failures = [
    ...verdicts.filter((v) => v.status === "fail").map((v) => `${v.key}: ${v.reasons.join("; ")}`),
    ...missing.map((key) => `${key}: in the baseline but not reported by this run`),
    ...conflicts.map((key) => `${key}: reported twice with different values`),
  ];
  return { verdicts, missing, conflicts, failures, ok: failures.length === 0 };
}

/** The baseline with `scores` written over it; with `suites`, other suites keep their entries. */
export function nextBaseline(
  scores: readonly Score[],
  previous: Baseline | null,
  now: Date,
  suites?: readonly string[],
): Baseline {
  const wanted = suites ? new Set(suites) : null;
  const kept = Object.entries(previous?.scores ?? {}).filter(
    ([key]) => wanted && !wanted.has(key.split("/")[0] ?? ""),
  );
  const next: Record<string, BaselineEntry> = Object.fromEntries(kept);
  for (const score of scores) {
    next[keyOf(score)] = {
      value: round(score.value),
      passed: score.passed,
      total: score.total,
    };
  }
  return {
    updatedAt: now.toISOString(),
    scores: Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b))),
  };
}

/** Parses the JSON lines `recordScore` wrote. A line that is not a score is an error, with its number. */
export function parseScores(text: string): Score[] {
  const scores: Score[] = [];
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`scores line ${index + 1} is not JSON`);
    }
    const s = value as Partial<Score> | null;
    if (
      !s ||
      typeof s.suite !== "string" ||
      typeof s.metric !== "string" ||
      typeof s.value !== "number" ||
      !Number.isFinite(s.value) ||
      typeof s.passed !== "number" ||
      typeof s.total !== "number" ||
      !(s.threshold === null || typeof s.threshold === "number")
    ) {
      throw new Error(`scores line ${index + 1} is not a score`);
    }
    scores.push({
      suite: s.suite,
      metric: s.metric,
      value: s.value,
      passed: s.passed,
      total: s.total,
      threshold: s.threshold,
    });
  }
  return scores;
}

export function parseBaseline(text: string): Baseline {
  const value = JSON.parse(text) as Partial<Baseline> | null;
  if (
    !value ||
    typeof value.updatedAt !== "string" ||
    typeof value.scores !== "object" ||
    !value.scores
  ) {
    throw new Error("baseline.json must have updatedAt and scores");
  }
  for (const [key, entry] of Object.entries(value.scores)) {
    if (!entry || typeof entry.value !== "number" || !Number.isFinite(entry.value)) {
      throw new Error(`baseline.json: ${key} has no numeric value`);
    }
  }
  return value as Baseline;
}
