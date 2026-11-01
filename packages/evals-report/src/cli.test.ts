// `pnpm eval` end to end with a fake vitest: what it asks vitest to run, how it reads the scores,
// and when it exits non-zero (acceptance criteria 6, 7 and 8). The real suites are run by CI.
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Deps, main, parseArgs, type Runner } from "./cli.ts";
import type { Baseline } from "./compare.ts";
import type { Score } from "./record.ts";

let dir: string;
let stdout: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "evals-report-test-"));
  stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const parser = (over: Partial<Score> = {}): Score => ({
  suite: "parser",
  metric: "qty_unit",
  value: 100,
  passed: 500,
  total: 500,
  threshold: 95,
  ...over,
});

/** A vitest that records `scores` the way the evals do and exits with `exitCode`. */
function fakeRunner(scores: Score[], exitCode = 0, refBaseline: Baseline | null = null) {
  const calls: Array<{ args: readonly string[]; env: Record<string, string> }> = [];
  const runner: Runner = {
    vitest(args, env) {
      calls.push({ args, env });
      for (const score of scores)
        appendFileSync(env.EVAL_SCORES_FILE as string, `${JSON.stringify(score)}\n`);
      const outputFile = args.find((a) => a.startsWith("--outputFile.json="))?.split("=")[1];
      if (outputFile) {
        writeFileSync(
          outputFile,
          JSON.stringify({
            numTotalTests: 12,
            numPassedTests: 11,
            numFailedTests: exitCode ? 1 : 0,
            numPendingTests: 1,
          }),
        );
      }
      return exitCode;
    },
    gitShow: () => (refBaseline ? JSON.stringify(refBaseline) : null),
  };
  return { runner, calls };
}

function setup(baseline?: Baseline) {
  const baselinePath = join(dir, "baseline.json");
  if (baseline) writeFileSync(baselinePath, JSON.stringify(baseline));
  const report = join(dir, "report.json");
  return { baselinePath, report };
}

const baseline = (value: number): Baseline => ({
  updatedAt: "2026-10-31T00:00:00.000Z",
  scores: { "parser/qty_unit": { value, passed: 0, total: 0 } },
});

describe("parseArgs", () => {
  it("reads the suites, --live, the baseline options and passes the rest to vitest", () => {
    expect(
      parseArgs([
        "--suite",
        "parser,lineItems",
        "--live",
        "--baseline-ref",
        "origin/main",
        "-t",
        "qty",
      ]),
    ).toMatchObject({
      suites: ["parser", "lineItems"],
      live: true,
      baselineRef: "origin/main",
      vitestArgs: ["-t", "qty"],
    });
    expect(parseArgs(["--suite", "import", "--suite", "import"]).suites).toEqual(["import"]);
    expect(parseArgs(["--max-regression", "5", "--update-baseline", "--comment"])).toMatchObject({
      maxRegression: 5,
      updateBaseline: true,
      comment: true,
    });
  });

  it("refuses an unknown suite and a flag with no value", () => {
    expect(() => parseArgs(["--suite", "recipes"])).toThrow(/unknown suite "recipes"/);
    expect(() => parseArgs(["--suite"])).toThrow(/needs a value/);
    expect(() => parseArgs(["--max-regression", "x"])).toThrow(/number of points/);
  });
});

describe("pnpm eval", () => {
  it("runs the evals project offline, writes report.json, prints the summary and exits 0", async () => {
    const { baselinePath, report } = setup(baseline(100));
    const { runner, calls } = fakeRunner([
      parser(),
      parser({ metric: "ingredient_id", threshold: 90 }),
    ]);
    const outcome = await main(["--report", report], { runner, baselinePath, env: {} });

    expect(outcome.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args.slice(0, 3)).toEqual(["run", "--project", "evals"]);
    expect(calls[0]?.env.EVAL_LIVE).toBeUndefined();
    const written = JSON.parse(readFileSync(report, "utf8"));
    expect(written).toMatchObject({ ok: true, vitestExit: 0, live: false });
    expect(written.scores.map((s: { key: string }) => s.key)).toEqual([
      "parser/ingredient_id",
      "parser/qty_unit",
    ]);
    expect(written.tests).toEqual({ total: 12, passed: 11, failed: 0, skipped: 1 });
    expect(stdout.mock.calls.map(String).join("")).toContain("### Evals: pass");
  });

  it("--suite runs only that suite's files and compares only its scores", async () => {
    const { baselinePath, report } = setup({
      updatedAt: "2026-10-31T00:00:00.000Z",
      scores: {
        "parser/qty_unit": { value: 100, passed: 0, total: 0 },
        "lineItems/kroger": { value: 99, passed: 0, total: 0 },
      },
    });
    const { runner, calls } = fakeRunner([parser()]);
    const outcome = await main(["--suite", "parser", "--report", report], {
      runner,
      baselinePath,
      env: {},
    });
    expect(outcome.exitCode).toBe(0);
    expect(calls[0]?.args).toContain("packages/ingredient-parser/evals/");
    expect(calls[0]?.args).not.toContain("packages/agent/evals/line-items/");
  });

  it("--live sets EVAL_LIVE for vitest", async () => {
    const { baselinePath, report } = setup();
    const { runner, calls } = fakeRunner([parser()]);
    await main(["--live", "--report", report], { runner, baselinePath, env: {} });
    expect(calls[0]?.env.EVAL_LIVE).toBe("1");
  });

  it("exits non-zero when a score is below its threshold (criterion 7)", async () => {
    const { baselinePath, report } = setup();
    const { runner } = fakeRunner([parser({ value: 94, passed: 470 })]);
    const outcome = await main(["--suite", "parser", "--report", report], {
      runner,
      baselinePath,
      env: {},
    });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.markdown).toContain("### Evals: FAIL");
    expect(outcome.markdown).toContain("below the threshold of 95%");
    expect(JSON.parse(readFileSync(report, "utf8")).ok).toBe(false);
  });

  it("exits non-zero when a score fell more than two points below the baseline, though over its threshold", async () => {
    const { baselinePath, report } = setup(baseline(100));
    const { runner } = fakeRunner([parser({ value: 96.9 })]);
    const outcome = await main(["--report", report], { runner, baselinePath, env: {} });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.markdown).toMatch(/fell 3\.1 points from the baseline 100%/);
  });

  it("exits non-zero when vitest fails, whatever the scores say", async () => {
    const { baselinePath, report } = setup();
    const { runner } = fakeRunner([parser()], 1);
    const outcome = await main(["--report", report], { runner, baselinePath, env: {} });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.markdown).toContain("vitest exited with 1");
  });

  it("exits non-zero when no score was reported at all, and when a baseline score is missing", async () => {
    const { baselinePath, report } = setup(baseline(100));
    const none = await main(["--report", report], {
      runner: fakeRunner([]).runner,
      baselinePath,
      env: {},
    });
    expect(none.exitCode).toBe(1);
    expect(none.markdown).toContain("no scores were reported");
    const other = await main(["--report", report], {
      runner: fakeRunner([parser({ suite: "import", metric: "pass_rate", threshold: 90 })]).runner,
      baselinePath,
      env: {},
    });
    expect(other.exitCode).toBe(1);
    expect(other.markdown).toContain("parser/qty_unit: in the baseline but not reported");
  });

  it("compares with baseline.json as it is on the ref when one is given (CI: origin/main)", async () => {
    // The working copy was edited to forgive the drop; the ref's copy is what counts.
    const { baselinePath, report } = setup(baseline(90));
    const { runner } = fakeRunner([parser({ value: 96 })], 0, baseline(100));
    const outcome = await main(["--baseline-ref", "origin/main", "--report", report], {
      runner,
      baselinePath,
      env: {},
    });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.markdown).toContain("origin/main (2026-10-31)");

    const noRef = await main(["--baseline-ref", "origin/main", "--report", report], {
      runner: fakeRunner([parser({ value: 96 })]).runner,
      baselinePath,
      env: {},
    });
    expect(noRef.exitCode).toBe(0);
    expect(noRef.markdown).toContain("working copy (none on origin/main)");
  });

  it("--update-baseline writes the scores after a passing run, and not after a failing one", async () => {
    const { baselinePath, report } = setup(baseline(100));
    const failing = fakeRunner([parser({ value: 90 })]).runner;
    await main(["--update-baseline", "--report", report], {
      runner: failing,
      baselinePath,
      env: {},
    });
    expect(JSON.parse(readFileSync(baselinePath, "utf8")).scores["parser/qty_unit"].value).toBe(
      100,
    );

    const passing = fakeRunner([parser({ value: 99, passed: 495 })]).runner;
    await main(["--update-baseline", "--max-regression", "5", "--report", report], {
      runner: passing,
      baselinePath,
      env: {},
    });
    const written = JSON.parse(readFileSync(baselinePath, "utf8"));
    expect(written.scores["parser/qty_unit"]).toEqual({ value: 99, passed: 495, total: 500 });
  });

  it("writes the job summary when GitHub gives it a file", async () => {
    const { baselinePath, report } = setup();
    const summary = join(dir, "summary.md");
    await main(["--report", report], {
      runner: fakeRunner([parser()]).runner,
      baselinePath,
      env: { GITHUB_STEP_SUMMARY: summary },
    });
    expect(readFileSync(summary, "utf8")).toContain("### Evals: pass");
  });

  it("--comment posts on a pull request run and says so otherwise", async () => {
    const { baselinePath, report } = setup();
    const event = join(dir, "event.json");
    writeFileSync(event, JSON.stringify({ pull_request: { number: 31 } }));
    const calls: Array<{ method: string; url: string }> = [];
    const doFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url });
      return init?.method === "POST" ? Response.json({ id: 5 }) : Response.json([]);
    }) as unknown as typeof fetch;
    const deps: Deps = {
      runner: fakeRunner([parser()]).runner,
      baselinePath,
      fetch: doFetch,
      env: {
        GITHUB_TOKEN: "t",
        GITHUB_REPOSITORY: "miguelsolorio/souvie",
        GITHUB_EVENT_PATH: event,
      },
    };
    await main(["--comment", "--report", report], deps);
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    expect(stdout.mock.calls.map(String).join("")).toContain("Comment created on #31");

    calls.length = 0;
    await main(["--comment", "--report", report], { ...deps, env: {} });
    expect(calls).toEqual([]);
  });
});
