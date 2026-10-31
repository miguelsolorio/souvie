// Every recorded run replays to its recorded outcome (WS09 criterion 8): the same proposal (status,
// product, quantity and flags per line), the same number of tool calls, the same final state, the
// same ledger, and the same cart. The model's turns come from the recording, so this runs with no
// key and no network; any change in what code sends, how it maps an index, or how it pushes the
// cart shows up here. Re-record with evals/record.ts when a change is meant to alter outcomes.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MockRetailer } from "@mp/retailers/mock";
import { describe, expect, it } from "vitest";
import { type RunFixture, replayRun } from "../src/replay.ts";

const RUNS_DIR = join(dirname(fileURLToPath(import.meta.url)), "runs");
const fixtures: RunFixture[] = readdirSync(RUNS_DIR)
  .filter((file) => file.endsWith(".json"))
  .sort()
  .map((file) => JSON.parse(readFileSync(join(RUNS_DIR, file), "utf8")) as RunFixture);

describe("recorded runs replay against MockRetailer", () => {
  it("has at least five recordings", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(5);
  });

  it.each(fixtures.map((f) => [f.name, f] as const))(
    "%s replays to its recorded state and ledger",
    async (_name, fixture) => {
      const result = await replayRun(fixture, new MockRetailer({ seed: fixture.adapter.seed }));
      expect(result.ranOut).toBe(false);
      expect(result.modelCalls).toBe(fixture.turns.length);
      expect(result.planned).toEqual(fixture.expected.planned);
      expect(result.toolCalls).toBe(fixture.expected.toolCalls);
      expect(result.finalStatus).toBe(fixture.expected.finalStatus);
      expect(result.ledger).toEqual(fixture.expected.ledger);
      expect(result.cart).toEqual(fixture.expected.cart);
    },
  );

  it("the real model named products by index only: no id or UPC in any recorded tool call (R13)", () => {
    for (const fixture of fixtures) {
      const calls = fixture.turns.flatMap((turn) =>
        turn.content.filter((block) => block.type === "tool_use"),
      );
      expect(calls.length, fixture.name).toBeGreaterThan(0);
      for (const call of calls) {
        const input = JSON.stringify((call as { input?: unknown }).input ?? {});
        expect(input, fixture.name).not.toMatch(/\d{8,14}/);
        expect(input, fixture.name).not.toMatch(/"(productId|upc|product_id)"/);
      }
    }
  });
});
