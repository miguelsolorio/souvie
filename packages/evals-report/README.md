# @mp/evals-report

`pnpm eval` (WS15). It runs every golden set, collects the score each one records, and fails the run when a score is below its threshold, more than 2 points below the baseline from `main`, or missing. The thresholds and what each set measures are in `docs/03-ai-design.md` §10.

```bash
pnpm eval                          # all sets, offline; writes packages/evals-report/report.json
pnpm eval --suite parser           # import | parser | lineItems | agentReplay | suggest
pnpm eval --suite parser --live    # call the models and re-record (ANTHROPIC_API_KEY in the process)
pnpm eval --update-baseline        # after a passing run, write the scores to baseline.json
pnpm eval:plain                    # the raw vitest run, no report and no gate
```

Other options: `--baseline <file>`, `--baseline-ref origin/main` (CI compares with main), `--report <file>`, `--max-regression <points>`, `--comment` (post the summary on the pull request). Anything else goes to vitest, so `pnpm eval -t "kroger"` filters by test name.

## How a set reports

The sets are the `*.eval.ts` files under each package's `evals/` folder (the `evals` project of the root `vitest.config.ts`). Each asserts its own threshold, so a bare `vitest run --project evals` still fails on a regression of its own. Each also calls `recordScore({ suite, metric, value, passed, total, threshold })` from `src/record.ts`, which appends a JSON line to the file named by `EVAL_SCORES_FILE`. `pnpm eval` sets that variable, reads the lines back, and compares them with `baseline.json`. A new set adds one `recordScore` call and one line to `src/suites.ts`.

| Suite | Scores | Where |
|---|---|---|
| `import` | `pass_rate` | `packages/recipe-import/evals/import.eval.ts` |
| `parser` | `qty_unit`, `ingredient_id`, and the same `_with_model` | `packages/ingredient-parser/evals/parse.eval.ts`, `parse-recorded.eval.ts` |
| `lineItems` | `kroger`, `safeway`, and `*_candidate_recall` | `packages/agent/evals/line-items/line-items.eval.ts` |
| `agentReplay` | `replay_pass_rate` | `packages/agent/evals/agent.eval.ts` |
| `suggest` | `households_clean` | `packages/llm/evals/suggest/suggest.eval.ts` |

## The gate

- A score under its `threshold` fails. A score with no threshold (`threshold: null`) is reported and compared with the baseline only.
- A score more than 2 points under its `baseline.json` entry fails, even when it clears its threshold.
- A baseline entry with no score in the run fails: a suite that stopped running must not read as a pass. With `--suite`, only that suite's entries are checked.
- A run that reports no score at all, or in which vitest exits non-zero, fails.
- `EVAL_REQUIRE_RECORDINGS=1` (set in CI) makes a model-path case with no recording a failure inside the set.

`baseline.json` is written only by `pnpm eval --update-baseline`, and only after a passing run. The `Evals` workflow (`.github/workflows/eval.yml`) compares a pull request with the copy on `main`, so a pull request cannot lower its own baseline; to accept a lower score on purpose, change the baseline on `main` first.

## Offline and live

Offline, a model path replays a recording keyed by a hash of the model, the prompt version and the prompt text. `--live` (which sets `EVAL_LIVE=1`) calls the models and writes new recordings; run it locally before changing a prompt, read the diff, and commit the recordings with the change. The recordings are in `packages/ingredient-parser/evals/recordings/`, `packages/recipe-import/evals/fixtures/llm/` and the turns inside `packages/agent/evals/runs/*.json`.

## Files

- `src/cli.ts`: the command. `src/suites.ts`: suite names and the paths they run. `src/compare.ts`: the gate and the baseline file. `src/markdown.ts`: the summary. `src/comment.ts`: the pull request comment, edited in place. `src/record.ts`: `recordScore`.
- `baseline.json`: the last accepted scores. `report.json` (ignored): the last run, uploaded by CI.
