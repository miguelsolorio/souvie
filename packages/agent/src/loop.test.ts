import {
  type AiRunRecord,
  callWithTools,
  LlmError,
  type MessageParam,
  type ResponseBlock,
  type ToolMessagesClient,
  type ToolTurnResponse,
} from "@mp/llm";
import { MockRetailer } from "@mp/retailers/mock";
import { describe, expect, it } from "vitest";
import type { ModelCaller } from "./loop.ts";
import { storeById } from "./replay.ts";
import { planRun } from "./run.ts";
import { context, MOCK_STORE_ID, twelveLines } from "./testing/fixtures.ts";

/** The line ids in the planner's first user message. */
function linesIn(messages: readonly MessageParam[]): string[] {
  const first = messages[0];
  const content = first?.content;
  const text =
    typeof content === "string"
      ? content
      : (content ?? [])
          .map((block) => ("text" in block && typeof block.text === "string" ? block.text : ""))
          .join("\n");
  return [...text.matchAll(/^Line (\S+):/gm)].map((m) => m[1] ?? "");
}

/**
 * A fake Anthropic client: on the first turn it chooses candidate 0 for every line it was given
 * and asks for review in the same turn, like a model making parallel tool calls.
 */
function fakeClient(
  script: "choose_all" | "bad_index" | "silent" = "choose_all",
): ToolMessagesClient & { requests: Record<string, unknown>[]; responses: ToolTurnResponse[] } {
  const requests: Record<string, unknown>[] = [];
  const responses: ToolTurnResponse[] = [];
  return {
    requests,
    responses,
    messages: {
      async create(params) {
        requests.push(params);
        const messages = params.messages as MessageParam[];
        const turn = messages.filter((m) => m.role === "assistant").length;
        const ids = linesIn(messages);
        let content: ResponseBlock[];
        if (script === "silent") {
          content = [{ type: "text", text: "I would rather not." }];
        } else if (script === "bad_index") {
          content =
            turn < 2
              ? ids.map((id, i) => ({
                  type: "tool_use",
                  id: `t${turn}-${i}`,
                  name: "choose_product",
                  input: { listItemId: id, candidateIndex: 40, quantity: 1 },
                }))
              : [{ type: "tool_use", id: `t${turn}-r`, name: "request_review", input: {} }];
        } else {
          content = [
            ...ids.map((id, i) => ({
              type: "tool_use",
              id: `t${turn}-${i}`,
              name: "choose_product",
              input: {
                listItemId: id,
                candidateIndex: 0,
                quantity: 1,
                reason: "Closest to the line.",
              },
            })),
            { type: "tool_use", id: `t${turn}-r`, name: "request_review", input: {} },
          ];
        }
        const response: ToolTurnResponse = {
          content,
          stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
          // A realistic turn: about 4,000 tokens of tools and prompt, mostly cached after turn one.
          usage:
            turn === 0
              ? {
                  input_tokens: 2200,
                  output_tokens: 600,
                  cache_read_input_tokens: 0,
                  cache_creation_input_tokens: 2100,
                }
              : {
                  input_tokens: 400,
                  output_tokens: 150,
                  cache_read_input_tokens: 4300,
                  cache_creation_input_tokens: 0,
                },
        };
        responses.push(response);
        return response;
      },
    },
  };
}

async function setup() {
  const mock = new MockRetailer({ seed: 1 });
  const store = await storeById(mock, MOCK_STORE_ID);
  return { mock, store };
}

function modelOver(client: ToolMessagesClient, log: AiRunRecord[]): ModelCaller {
  return (request) =>
    callWithTools(
      { ...request, householdId: "household-test" },
      {
        client,
        log: (r) => {
          log.push(r);
        },
      },
    );
}

describe("the planning loop against MockRetailer, with a mocked model", () => {
  it("turns a 12-line list into 12 run items, at least 10 matched, with no cart write before review", async () => {
    const { mock, store } = await setup();
    const client = fakeClient();
    const log: AiRunRecord[] = [];
    const result = await planRun(context(store, twelveLines()), {
      adapter: mock,
      callModel: modelOver(client, log),
    });

    expect(result.items).toHaveLength(12);
    expect(result.items.filter((i) => i.status === "matched").length).toBeGreaterThanOrEqual(10);
    expect(result.status).toBe("needs_review");
    expect(
      mock.calls.filter((c) => c.operation === "addToCart" || c.operation === "removeFromCart"),
    ).toEqual([]);
    expect(result.push).toEqual({
      type: "needs_review",
      runId: "run-test",
      count: result.snapshot.needsReviewCount,
    });

    // One transcript entry per tool call, the host's and the model's.
    expect(result.transcript).toHaveLength(result.toolCalls);
    const asked = client.responses.flatMap((r) => r.content.filter((b) => b.type === "tool_use"));
    const fromModel = result.transcript.filter((e) => e.by === "model");
    expect(fromModel.length).toBeGreaterThan(0);
    // Every tool_use the model sent is exactly one transcript entry.
    expect(fromModel).toHaveLength(asked.length);
    expect(log).toHaveLength(result.model.turns);
    expect(fromModel.at(-1)?.tool).toBe("request_review");
    // No product name or price in the transcript.
    const text = JSON.stringify(result.transcript);
    for (const item of result.items) {
      if (item.product) expect(text).not.toContain(item.product.name);
    }
    expect(text).not.toMatch(/\$\d/);
  });

  it("sends the model only the close calls, with strict tools, auto tool choice and cached system blocks", async () => {
    const { mock, store } = await setup();
    const client = fakeClient();
    await planRun(context(store, twelveLines()), {
      adapter: mock,
      callModel: modelOver(client, []),
    });
    const first = client.requests[0] as Record<string, unknown>;
    const ids = linesIn(first.messages as MessageParam[]);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThan(12);
    expect(ids).toContain("L12"); // the free-text line always goes to the model
    expect(first.tool_choice).toEqual({ type: "auto" });
    expect(first.thinking).toBeUndefined();
    expect(first.temperature).toBeUndefined();
    expect(first.output_config).toEqual({ effort: "low" });
    expect(first.model).toBe("claude-sonnet-5-5");
    const tools = first.tools as Array<{
      name: string;
      strict: boolean;
      input_schema: { additionalProperties: boolean };
    }>;
    expect(tools.map((t) => t.name)).toEqual([
      "find_store",
      "search_products",
      "get_product",
      "choose_product",
      "mark_unmatched",
      "request_review",
    ]);
    expect(tools.every((t) => t.strict && t.input_schema.additionalProperties === false)).toBe(
      true,
    );
    const system = first.system as Array<{ cache_control?: unknown }>;
    expect(system.every((block) => block.cache_control)).toBe(true);
  });

  it("logs one ai_runs record per model call, agent_plan then agent_step, and the mock run costs well under $0.25", async () => {
    const { mock, store } = await setup();
    const client = fakeClient("bad_index");
    const log: AiRunRecord[] = [];
    const result = await planRun(context(store, twelveLines()), {
      adapter: mock,
      callModel: modelOver(client, log),
    });
    expect(log.map((r) => r.kind)).toEqual(["agent_plan", "agent_step", "agent_step"]);
    expect(
      log.every((r) => r.promptVersion === "agent-system.v1" && r.householdId === "household-test"),
    ).toBe(true);
    const cost = log.reduce((sum, r) => sum + r.costUsd, 0);
    expect(cost).toBeLessThan(0.25);
    expect(result.model.costUsd).toBeCloseTo(cost, 8);
  });

  it("gives up a line after two bad indices and leaves it for the person", async () => {
    const { mock, store } = await setup();
    const result = await planRun(context(store, twelveLines()), {
      adapter: mock,
      callModel: modelOver(fakeClient("bad_index"), []),
    });
    const broth = result.items.find((i) => i.listItemId === "L12");
    expect(broth?.status).toBe("unmatched");
    expect(broth?.flags.map((f) => f.kind)).toContain("low_confidence");
  });

  it("nudges a silent model once, then lets code pick and flag the close calls", async () => {
    const { mock, store } = await setup();
    const client = fakeClient("silent");
    const result = await planRun(context(store, twelveLines()), {
      adapter: mock,
      callModel: modelOver(client, []),
    });
    expect(client.requests).toHaveLength(2);
    expect(result.model.stoppedBy).toBe("end_turn");
    const icecream = result.items.find((i) => i.listItemId === "L12");
    expect(icecream?.status).toBe("matched");
    expect(icecream?.flags.map((f) => f.kind)).toContain("low_confidence");
  });

  it("without a model, code picks the close calls and says so", async () => {
    const { mock, store } = await setup();
    const result = await planRun(context(store, twelveLines()), { adapter: mock, callModel: null });
    expect(result.snapshot.flags.map((f) => f.kind)).toContain("model_unavailable");
    expect(result.items.filter((i) => i.status === "matched").length).toBeGreaterThanOrEqual(10);
  });

  it("treats a refusal or an API error like no model", async () => {
    const { mock, store } = await setup();
    const failing: ModelCaller = async () => {
      throw new LlmError("refusal", "declined");
    };
    const result = await planRun(context(store, twelveLines()), {
      adapter: mock,
      callModel: failing,
    });
    expect(result.model.stoppedBy).toBe("error");
    expect(result.snapshot.flags.map((f) => f.kind)).toContain("model_unavailable");
  });

  it("stops at max_tool_calls and flags what was left", async () => {
    const { mock, store } = await setup();
    const result = await planRun(context(store, twelveLines(), { policy: { max_tool_calls: 5 } }), {
      adapter: mock,
      callModel: modelOver(fakeClient(), []),
    });
    expect(result.items).toHaveLength(12);
    expect(result.snapshot.flags.map((f) => f.kind)).toContain("limit_reached");
    expect(mock.calls.filter((c) => c.operation === "searchProducts")).toHaveLength(5);
    expect(
      result.items.filter((i) => i.flags.some((f) => f.kind === "limit_reached")).length,
    ).toBeGreaterThan(0);
  });

  it("stops the model at the wall clock", async () => {
    const { mock, store } = await setup();
    let clock = 0;
    const result = await planRun(
      context(store, twelveLines(), { policy: { max_wall_clock_seconds: 1 } }),
      {
        adapter: mock,
        callModel: modelOver(fakeClient(), []),
        now: () => {
          clock += 100;
          return clock;
        },
      },
    );
    expect(result.model.stoppedBy).toBe("deadline");
    expect(result.items.every((i) => i.status !== "proposed")).toBe(true);
  });

  it("stops when the run is cancelled and reports it", async () => {
    const { mock, store } = await setup();
    let checks = 0;
    const result = await planRun(context(store, twelveLines()), {
      adapter: mock,
      callModel: null,
      cancelled: async () => ++checks > 3,
    });
    expect(result.cancelled).toBe(true);
    expect(mock.calls.filter((c) => c.operation === "searchProducts").length).toBe(3);
  });
});
