// `pnpm eval [--suite import|parser|lineItems|agentReplay|suggest] [--live] [vitest filters]`
//
// Runs the golden sets (the `evals` project of the root vitest config), collects the score each
// one records, compares them with the thresholds and with the baseline from main, writes
// packages/evals-report/report.json, prints a Markdown summary, and exits non-zero when anything
// failed. Offline by default: model answers come from the recordings next to each eval, and
// EVAL_REQUIRE_RECORDINGS=1 (CI) makes a missing recording a failure.
//
//   --live               call the models and re-record (needs ANTHROPIC_API_KEY); sets EVAL_LIVE=1
//   --suite <name>       one suite (repeatable); only its scores are compared
//   --baseline <file>    compare with this baseline instead of packages/evals-report/baseline.json
//   --baseline-ref <ref> compare with baseline.json as it is on this git ref (CI: origin/main)
//   --update-baseline    after a passing run, write the scores to baseline.json
//   --report <file>      where to write the report (default packages/evals-report/report.json)
//   --comment            post the summary on the pull request (GITHUB_TOKEN, GITHUB_EVENT_PATH)
//   --max-regression <n> points a score may fall below the baseline (default 2)
//   anything else        passed to vitest (a test name filter, for example)
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pullNumberOf, upsertComment } from "./comment.ts";
import {
  type Baseline,
  evaluate,
  MAX_REGRESSION_POINTS,
  nextBaseline,
  parseBaseline,
  parseScores,
} from "./compare.ts";
import { renderMarkdown } from "./markdown.ts";
import { isSuite, SUITE_NAMES, SUITES, type SuiteName } from "./suites.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_DIR = join(HERE, "..");
export const REPO_ROOT = join(PACKAGE_DIR, "..", "..");
export const BASELINE_PATH = join(PACKAGE_DIR, "baseline.json");
export const REPORT_PATH = join(PACKAGE_DIR, "report.json");

export interface Args {
  suites: SuiteName[];
  live: boolean;
  baseline: string | null;
  baselineRef: string | null;
  updateBaseline: boolean;
  report: string;
  comment: boolean;
  maxRegression: number;
  vitestArgs: string[];
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    suites: [],
    live: false,
    baseline: null,
    baselineRef: null,
    updateBaseline: false,
    report: REPORT_PATH,
    comment: false,
    maxRegression: MAX_REGRESSION_POINTS,
    vitestArgs: [],
  };
  const value = (flag: string, index: number): string => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value`);
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--") continue;
    if (arg === "--live") args.live = true;
    else if (arg === "--update-baseline") args.updateBaseline = true;
    else if (arg === "--comment") args.comment = true;
    else if (arg === "--suite") {
      for (const name of value(arg, i++).split(",")) {
        if (!isSuite(name)) {
          throw new Error(`unknown suite "${name}"; the suites are ${SUITE_NAMES.join(", ")}`);
        }
        if (!args.suites.includes(name)) args.suites.push(name);
      }
    } else if (arg === "--baseline") args.baseline = value(arg, i++);
    else if (arg === "--baseline-ref") args.baselineRef = value(arg, i++);
    else if (arg === "--report") args.report = value(arg, i++);
    else if (arg === "--max-regression") {
      const n = Number(value(arg, i++));
      if (!Number.isFinite(n) || n < 0)
        throw new Error("--max-regression needs a number of points");
      args.maxRegression = n;
    } else args.vitestArgs.push(arg);
  }
  return args;
}

export interface VitestSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

export interface Runner {
  /** Runs vitest with these arguments and environment; returns its exit code. */
  vitest(args: readonly string[], env: Record<string, string>): number;
  /** The text of baseline.json at a git ref, or null. */
  gitShow(ref: string, path: string): string | null;
}

export const realRunner: Runner = {
  vitest(args, env) {
    const result = spawnSync("pnpm", ["exec", "vitest", ...args], {
      cwd: REPO_ROOT,
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    return result.status ?? 1;
  },
  gitShow(ref, path) {
    const result = spawnSync("git", ["show", `${ref}:${path}`], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return result.status === 0 ? result.stdout : null;
  },
};

function readSummary(file: string): VitestSummary | null {
  try {
    const json = JSON.parse(readFileSync(file, "utf8")) as {
      numTotalTests?: number;
      numPassedTests?: number;
      numFailedTests?: number;
      numPendingTests?: number;
    };
    return {
      total: json.numTotalTests ?? 0,
      passed: json.numPassedTests ?? 0,
      failed: json.numFailedTests ?? 0,
      skipped: json.numPendingTests ?? 0,
    };
  } catch {
    return null;
  }
}

export interface Outcome {
  exitCode: number;
  markdown: string;
  reportPath: string;
}

export interface Deps {
  runner?: Runner;
  env?: Record<string, string | undefined>;
  /** The working copy of baseline.json that is read and, with --update-baseline, written. */
  baselinePath?: string;
  fetch?: typeof fetch;
}

export async function main(argv: readonly string[], deps: Deps = {}): Promise<Outcome> {
  const runner = deps.runner ?? realRunner;
  const env = deps.env ?? process.env;
  const baselinePath = deps.baselinePath ?? BASELINE_PATH;
  const args = parseArgs(argv);
  const work = mkdtempSync(join(tmpdir(), "souvie-evals-"));
  const scoresFile = join(work, "scores.jsonl");
  const summaryFile = join(work, "vitest.json");
  writeFileSync(scoresFile, "");

  try {
    const filters = args.suites.flatMap((name) => [...SUITES[name]]);
    const exitCode = runner.vitest(
      [
        "run",
        "--project",
        "evals",
        "--passWithNoTests",
        "--reporter=default",
        "--reporter=json",
        `--outputFile.json=${summaryFile}`,
        ...filters,
        ...args.vitestArgs,
      ],
      {
        EVAL_SCORES_FILE: scoresFile,
        ...(args.live ? { EVAL_LIVE: "1" } : {}),
      },
    );

    // The baseline: a file, or the one on a git ref (CI compares with main), else the working copy.
    let baseline: Baseline | null = null;
    let baselineSource = "none";
    const baselineRelative = "packages/evals-report/baseline.json";
    if (args.baseline) {
      baseline = parseBaseline(readFileSync(args.baseline, "utf8"));
      baselineSource = args.baseline;
    } else {
      const fromRef = args.baselineRef ? runner.gitShow(args.baselineRef, baselineRelative) : null;
      if (fromRef !== null) {
        baseline = parseBaseline(fromRef);
        baselineSource = `${args.baselineRef} (${baseline.updatedAt.slice(0, 10)})`;
      } else if (existsSync(baselinePath)) {
        baseline = parseBaseline(readFileSync(baselinePath, "utf8"));
        const which = args.baselineRef
          ? `working copy (none on ${args.baselineRef})`
          : "baseline.json";
        baselineSource = `${which} (${baseline.updatedAt.slice(0, 10)})`;
      }
    }

    const scores = parseScores(readFileSync(scoresFile, "utf8"));
    const evaluation = evaluate(scores, baseline, {
      maxRegression: args.maxRegression,
      suites: args.suites.length > 0 ? args.suites : undefined,
    });
    const tests = readSummary(summaryFile);
    const markdown = renderMarkdown(evaluation, {
      vitestExit: exitCode,
      tests,
      baselineSource,
      suites: args.suites.length > 0 ? args.suites : null,
      live: args.live,
    });

    // A run that reported no score at all is a failure, not a pass: a suite that stopped running
    // must never read as green.
    const ok = exitCode === 0 && evaluation.ok && scores.length > 0;
    const report = {
      generatedAt: new Date().toISOString(),
      ok,
      vitestExit: exitCode,
      tests,
      suites: args.suites.length > 0 ? args.suites : SUITE_NAMES,
      baselineSource,
      live: args.live,
      scores: evaluation.verdicts,
      missing: evaluation.missing,
      failures: evaluation.failures,
    };
    mkdirSync(dirname(args.report), { recursive: true });
    writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`);

    process.stdout.write(`\n${markdown}`);
    const stepSummary = env.GITHUB_STEP_SUMMARY;
    if (stepSummary) writeFileSync(stepSummary, markdown, { flag: "a" });

    if (args.comment) await postComment(markdown, env, deps.fetch);

    if (args.updateBaseline) {
      if (!ok) {
        process.stderr.write("\nNot updating baseline.json: the run did not pass.\n");
      } else {
        const next = nextBaseline(
          scores,
          existsSync(baselinePath) ? parseBaseline(readFileSync(baselinePath, "utf8")) : null,
          new Date(),
          args.suites.length > 0 ? args.suites : undefined,
        );
        writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
        process.stdout.write(
          `\nWrote ${baselinePath} (${Object.keys(next.scores).length} scores).\n`,
        );
      }
    }
    return { exitCode: ok ? 0 : 1, markdown, reportPath: args.report };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function postComment(
  markdown: string,
  env: Record<string, string | undefined>,
  doFetch?: typeof fetch,
): Promise<void> {
  const token = env.GITHUB_TOKEN;
  const repository = env.GITHUB_REPOSITORY;
  const eventPath = env.GITHUB_EVENT_PATH;
  if (!token || !repository || !eventPath || !existsSync(eventPath)) {
    process.stderr.write("\n--comment: not on a pull request run, so no comment was posted.\n");
    return;
  }
  const pullNumber = pullNumberOf(JSON.parse(readFileSync(eventPath, "utf8")));
  if (pullNumber === null) {
    process.stderr.write(
      "\n--comment: this event is not a pull request, so no comment was posted.\n",
    );
    return;
  }
  const result = await upsertComment(markdown, { repository, pullNumber, token }, doFetch);
  process.stdout.write(
    result.kind === "failed"
      ? `\nThe comment was not posted (${result.reason}).\n`
      : `\nComment ${result.kind} on #${pullNumber}.\n`,
  );
}

// Run as a script, not when a test imports it.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (outcome) => {
      process.exitCode = outcome.exitCode;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    },
  );
}
