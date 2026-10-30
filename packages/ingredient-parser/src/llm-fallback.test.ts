import { describe, expect, it } from "vitest";
import {
  buildSystemPrompt,
  buildUserPrompt,
  createAnthropicParseClient,
  estimateCostUsd,
  HAIKU_MODEL,
  INGREDIENT_PARSE_PROMPT_VERSION,
  type LlmItem,
  LlmParseError,
  type MessagesParseLike,
  sanitizeItem,
} from "./llm-fallback";

type ParseParams = Record<string, unknown>;
type ParseResult = Awaited<ReturnType<MessagesParseLike["messages"]["parse"]>>;

function fakeSdk(result: ParseResult | Error): { sdk: MessagesParseLike; calls: ParseParams[] } {
  const calls: ParseParams[] = [];
  return {
    calls,
    sdk: {
      messages: {
        async parse(params) {
          calls.push(params);
          if (result instanceof Error) throw result;
          return result;
        },
      },
    },
  };
}

const okItem = {
  qty: 2,
  qty_max: null,
  unit: "cups",
  ingredient: "Yellow Onion",
  category: "produce",
  prep: "diced",
  optional: false,
  confidence: 0.93,
};

const ok = (lines: unknown[]): ParseResult => ({
  parsed_output: { lines },
  stop_reason: "end_turn",
  usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 900 },
});

describe("createAnthropicParseClient", () => {
  it("sends a strict, cached, low-effort Haiku request with no sampling parameters", async () => {
    const { sdk, calls } = fakeSdk(ok([{ index: 0, items: [okItem] }]));
    const client = createAnthropicParseClient({ client: sdk });
    await client.parseBatch(["2 cups diced yellow onion"]);

    expect(client.model).toBe("claude-haiku-5-5");
    expect(client.model).toBe(HAIKU_MODEL);
    const req = calls[0] as Record<string, unknown>;
    expect(req.model).toBe("claude-haiku-5-5");
    expect(req.max_tokens).toBeGreaterThanOrEqual(1024);
    // Haiku 5.5 rejects non-default sampling parameters and budget_tokens.
    for (const key of ["temperature", "top_p", "top_k", "thinking", "tool_choice"]) {
      expect(req).not.toHaveProperty(key);
    }
    const system = req.system as { type: string; text: string; cache_control?: { type: string } }[];
    expect(system[0]?.text).toBe(buildSystemPrompt());
    expect(system[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(req.messages).toEqual([
      { role: "user", content: buildUserPrompt(["2 cups diced yellow onion"]) },
    ]);

    const output = req.output_config as {
      effort: string;
      format: { type: string; schema: Record<string, unknown> };
    };
    expect(output.effort).toBe("low");
    expect(output.format.type).toBe("json_schema");
    expect(JSON.stringify(output.format.schema)).toContain("confidence");
  });

  it("maps the response by input index and normalizes each item", async () => {
    const { sdk } = fakeSdk(
      ok([
        { index: 1, items: [okItem] },
        { index: 0, items: [] },
        { index: 7, items: [okItem] }, // out of range: ignored
      ]),
    );
    const client = createAnthropicParseClient({
      client: sdk,
      now: (() => {
        let t = 100;
        return () => (t += 25);
      })(),
    });
    const result = await client.parseBatch(["a", "b"]);

    expect([...result.byIndex.keys()].sort()).toEqual([0, 1]);
    expect(result.byIndex.get(1)?.[0]).toMatchObject({
      qty: 2,
      unit: "cup",
      ingredient: "yellow onion",
      prep: "diced",
      confidence: 0.93,
    });
    expect(result.usage).toMatchObject({
      model: "claude-haiku-5-5",
      promptVersion: INGREDIENT_PARSE_PROMPT_VERSION,
      inputTokens: 1200,
      outputTokens: 80,
      cacheReadTokens: 900,
      ok: true,
      lines: 2,
    });
    expect(result.usage.latencyMs).toBe(25);
  });

  it("throws a typed error on refusal, truncation, bad schema, and API failure", async () => {
    const refusal = fakeSdk({ ...ok([]), stop_reason: "refusal" });
    await expect(
      createAnthropicParseClient({ client: refusal.sdk }).parseBatch(["x"]),
    ).rejects.toMatchObject({
      name: "LlmParseError",
      code: "refusal",
    });

    const truncated = fakeSdk({ ...ok([]), stop_reason: "max_tokens" });
    await expect(
      createAnthropicParseClient({ client: truncated.sdk }).parseBatch(["x"]),
    ).rejects.toMatchObject({
      code: "truncated",
    });

    const invalid = fakeSdk({ ...ok([]), parsed_output: { nope: true } });
    await expect(
      createAnthropicParseClient({ client: invalid.sdk }).parseBatch(["x"]),
    ).rejects.toMatchObject({
      code: "invalid",
    });

    const failing = fakeSdk(new Error("529 overloaded"));
    const err = await createAnthropicParseClient({ client: failing.sdk })
      .parseBatch(["x"])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmParseError);
    expect(err).toMatchObject({ code: "api", message: "529 overloaded" });
    expect((err as LlmParseError).usage).toMatchObject({
      ok: false,
      error: "529 overloaded",
      lines: 1,
    });
  });
});

describe("sanitizeItem", () => {
  const base: LlmItem = {
    qty: 1,
    qty_max: null,
    unit: "tbsp",
    ingredient: "  Olive   Oil ",
    category: "pantry",
    prep: "  ",
    optional: false,
    confidence: 0.8,
  };

  it("lowercases and trims the name and drops blank prep", () => {
    expect(sanitizeItem(base)).toMatchObject({ ingredient: "olive oil", prep: null });
  });
  it("turns an unknown unit into each and drops the unit when there is no qty", () => {
    expect(sanitizeItem({ ...base, unit: "splash" }).unit).toBe("each");
    expect(sanitizeItem({ ...base, qty: null, unit: "cup" }).unit).toBeNull();
  });
  it("keeps a range only when the high end is above the low end", () => {
    expect(sanitizeItem({ ...base, qty: 2, qty_max: 3 }).qty_max).toBe(3);
    expect(sanitizeItem({ ...base, qty: 3, qty_max: 2 }).qty_max).toBeNull();
  });
  it("clamps confidence and rejects negative quantities", () => {
    expect(sanitizeItem({ ...base, confidence: 7 }).confidence).toBe(1);
    expect(sanitizeItem({ ...base, confidence: -1 }).confidence).toBe(0);
    expect(sanitizeItem({ ...base, qty: -2 }).qty).toBeNull();
  });
});

describe("estimateCostUsd", () => {
  it("prices Haiku 5.5 at $0.10 in, $0.50 out, cache reads at a tenth of input", () => {
    expect(
      estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 }),
    ).toBeCloseTo(0.1, 8);
    expect(
      estimateCostUsd({ inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0 }),
    ).toBeCloseTo(0.5, 8);
    expect(
      estimateCostUsd({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 }),
    ).toBeCloseTo(0.01, 8);
  });
  it("keeps a 20-line batch well under a tenth of a cent", () => {
    expect(
      estimateCostUsd({ inputTokens: 900, outputTokens: 1200, cacheReadTokens: 0 }),
    ).toBeLessThan(0.001);
  });
});

describe("prompt", () => {
  it("lists the unit codes and categories the schema allows", () => {
    const system = buildSystemPrompt();
    for (const word of ["tbsp", "fl_oz", "each", "produce", "international", "qty_max"]) {
      expect(system).toContain(word);
    }
  });
  it("numbers the input lines from zero", () => {
    expect(buildUserPrompt(["a", "b"])).toBe("Parse these ingredient lines.\n\n0: a\n1: b");
  });
});
