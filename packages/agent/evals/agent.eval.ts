// `pnpm eval agent` (WS09; WS15 wires the thresholds into CI): replays every recorded run against
// MockRetailer and prints the replay pass rate and what each run cost the model, from the usage the
// live recording returned (claude-sonnet-5-5 prices in @mp/llm). docs/03-ai-design.md §10: a
// recorded run must reach the same final cart with no policy violation.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MockRetailer } from "@mp/retailers/mock";
import { describe, expect, it } from "vitest";
import { type RunFixture, replayRun } from "../src/replay.ts";

const RUNS_DIR = join(dirname(fileURLToPath(import.meta.url)), "runs");
/** The brief's ceiling for one 12-item mock run (criterion 14). */
const MAX_RUN_COST_USD = 0.25;

describe("agent replay eval", () => {
  it("replays 100% of recorded runs, each under the cost ceiling", async () => {
    const files = readdirSync(RUNS_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort();
    const rows: string[] = [];
    let passed = 0;
    for (const file of files) {
      const fixture = JSON.parse(readFileSync(join(RUNS_DIR, file), "utf8")) as RunFixture;
      const result = await replayRun(fixture, new MockRetailer({ seed: fixture.adapter.seed }));
      const ok =
        !result.ranOut &&
        JSON.stringify(result.planned) === JSON.stringify(fixture.expected.planned) &&
        result.finalStatus === fixture.expected.finalStatus &&
        JSON.stringify(result.ledger) === JSON.stringify(fixture.expected.ledger) &&
        JSON.stringify(result.cart) === JSON.stringify(fixture.expected.cart);
      if (ok) passed += 1;
      const matched = result.planned.filter(
        (p) => p.status === "matched" || p.status === "substituted",
      ).length;
      rows.push(
        `${ok ? "pass" : "FAIL"}  ${fixture.name.padEnd(24)} lines ${String(result.planned.length).padStart(2)}  matched ${String(matched).padStart(2)}  turns ${result.modelCalls}  tool calls ${String(result.toolCalls).padStart(2)}  model cost $${result.costUsd.toFixed(4)}`,
      );
      expect(result.costUsd).toBeLessThan(MAX_RUN_COST_USD);
    }
    const rate = files.length === 0 ? 0 : (passed / files.length) * 100;
    console.log(
      [
        "agent replay eval",
        ...rows,
        `replay pass rate: ${rate.toFixed(0)}% (${passed}/${files.length})`,
      ].join("\n"),
    );
    expect(files.length).toBeGreaterThanOrEqual(5);
    expect(passed).toBe(files.length);
  });
});
