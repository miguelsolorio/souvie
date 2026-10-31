// Records the replay fixtures in evals/runs/ (WS09). Developer tool only: it calls the real model,
// so it costs a few cents per scenario and needs ANTHROPIC_API_KEY in its own environment. Never in
// CI; the replay test and `pnpm eval` run the recordings with no key and no network.
//
//   ANTHROPIC_API_KEY=... node packages/agent/evals/record.ts [scenario ...]
//
// Each scenario runs against MockRetailer through replayRun with a live Sonnet model, the model's
// turns are captured as they come back, and the fixture is written with what the run produced:
// the proposal, the ledger, the cart. A recording is the expected outcome by definition; the replay
// test then proves the code reproduces it from the recorded turns alone.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { callWithTools, createAnthropicToolClient, MODELS, type ToolMessagesClient } from "@mp/llm";
import { MockRetailer } from "@mp/retailers/mock";
import type { ModelCaller } from "../src/loop.ts";
import { type RecordedTurn, type RunFixture, replayRun } from "../src/replay.ts";
import { SCENARIOS } from "./scenarios.ts";

const RUNS_DIR = join(dirname(fileURLToPath(import.meta.url)), "runs");

async function main(): Promise<void> {
  if (process.env.CI) throw new Error("record.ts calls the real model; it never runs in CI");
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set for this process");
  const wanted = new Set(process.argv.slice(2));
  const live = await createAnthropicToolClient({ apiKey });
  mkdirSync(RUNS_DIR, { recursive: true });

  let total = 0;
  for (const scenario of SCENARIOS) {
    if (wanted.size > 0 && !wanted.has(scenario.name)) continue;
    const turns: RecordedTurn[] = [];
    const recording: ToolMessagesClient = {
      messages: {
        async create(params) {
          const response = await live.messages.create(params);
          turns.push({
            content: response.content,
            stop_reason: response.stop_reason,
            usage: {
              input_tokens: response.usage.input_tokens,
              output_tokens: response.usage.output_tokens,
              cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
              cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
            },
          });
          return response;
        },
      },
    };
    let costUsd = 0;
    const callModel: ModelCaller = async (request) => {
      const result = await callWithTools({ ...request, householdId: null }, { client: recording });
      costUsd += result.costUsd;
      return result;
    };

    const fixture: RunFixture = {
      name: scenario.name,
      description: scenario.description,
      model: MODELS.sonnet,
      adapter: {
        seed: scenario.seed,
        ...(scenario.capabilities ? { capabilities: scenario.capabilities } : {}),
      },
      context: {
        runId: `replay-${scenario.name}`,
        householdId: "replay-household",
        storeId: scenario.storeId,
        policy: scenario.policy,
        allergies: scenario.allergies,
        preferences: scenario.preferences,
        lines: scenario.lines(),
        choices: scenario.choices,
      },
      turns: [],
      review: { decisions: scenario.review },
      expected: { planned: [], toolCalls: 0, finalStatus: "queued", ledger: [], cart: [] },
    };
    const result = await replayRun(fixture, new MockRetailer({ seed: scenario.seed }), {
      callModel,
    });
    fixture.turns = turns;
    fixture.expected = {
      planned: result.planned,
      toolCalls: result.toolCalls,
      finalStatus: result.finalStatus,
      ledger: result.ledger,
      cart: result.cart,
    };
    fixture.recorded = {
      at: new Date().toISOString(),
      note: `Recorded live against MockRetailer seed ${scenario.seed}: ${turns.length} model turns, $${costUsd.toFixed(4)}.`,
    };
    writeFileSync(join(RUNS_DIR, `${scenario.name}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
    total += costUsd;
    const matched = result.planned.filter(
      (p) => p.status === "matched" || p.status === "substituted",
    ).length;
    console.log(
      `${scenario.name}: ${turns.length} turns, ${result.toolCalls} tool calls, ${matched}/${result.planned.length} matched, final ${result.finalStatus}, $${costUsd.toFixed(4)}`,
    );
  }
  console.log(`total model cost: $${total.toFixed(4)}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
