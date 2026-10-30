// WS02 additions to the parser's model path: every model item is sanitized whichever client
// produced it, and a cached answer from an older prompt is a miss. Also the `@mp/llm` adapter's
// handling of retries and billed-but-failed calls.

import { describe, expect, it } from "vitest";
import { seedOntology } from "../evals/seed-ontology";
import {
  type CachedParse,
  cacheKey,
  createAnthropicParseClient,
  InMemoryParseCache,
  isCurrentPromptVersion,
  type LlmBatchResult,
  type LlmItem,
  type LlmParseClient,
  type MessagesParseLike,
  parseLine,
} from "./index";

const ontology = seedOntology();

function item(partial: Partial<LlmItem>): LlmItem {
  return {
    qty: null,
    qty_max: null,
    unit: null,
    ingredient: null,
    category: null,
    prep: null,
    optional: false,
    confidence: 0.9,
    ...partial,
  };
}

class FakeModel implements LlmParseClient {
  readonly model = "fake-haiku";
  readonly requests: string[][] = [];
  constructor(
    readonly promptVersion: string,
    private readonly answer: LlmItem[],
  ) {}

  async parseBatch(lines: readonly string[]): Promise<LlmBatchResult> {
    this.requests.push([...lines]);
    return {
      byIndex: new Map(lines.map((_l, i) => [i, this.answer])),
      usage: {
        model: this.model,
        promptVersion: this.promptVersion,
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        latencyMs: 1,
        ok: true,
        lines: lines.length,
      },
    };
  }
}

describe("a replacement LlmParseClient is not trusted", () => {
  it("sanitizes its items: names are lowercased, units normalized, junk numbers dropped", async () => {
    const dirty = item({
      qty: -2,
      qty_max: 5,
      unit: "splash",
      ingredient: "  Gochugaru   Flakes ",
      prep: "  ",
      confidence: 7,
    });
    const model = new FakeModel("ingredient-parse.v1", [dirty]);
    const parsed = await parseLine("a handful of mystery blorp", { ontology, llm: model });
    expect(parsed).toMatchObject({
      stage: "llm",
      qty: null,
      qtyMax: null,
      unit: null,
      ingredientName: "gochugaru flakes",
    });
    expect(parsed.confidence).toBeLessThanOrEqual(0.6);
    expect(parsed.confidence).toBeGreaterThanOrEqual(0);
    expect(parsed.prepNote ?? null).toBeNull();
  });

  it("drops an item whose name is only whitespace", async () => {
    const model = new FakeModel("ingredient-parse.v1", [
      item({ qty: 1, unit: "cup", ingredient: "   " }),
    ]);
    const parsed = await parseLine("1 cup zzzz", { ontology, llm: model });
    expect(parsed.stage).not.toBe("llm");
  });
});

describe("the parse cache and prompt versions", () => {
  const LINE = "1 tbsp gochugaru blorp";
  const entry = (promptVersion: string | null, items: CachedParse["items"] = []): CachedParse => ({
    items,
    source: "llm",
    model: "claude-haiku-5-5",
    promptVersion,
  });
  const answer = [item({ qty: 1, unit: "tbsp", ingredient: "gochugaru" })];

  it("asks the model again when the cached answer came from an older prompt", async () => {
    const cache = new InMemoryParseCache();
    cache.load([[cacheKey(LINE), entry("ingredient-parse.v1")]]);
    const model = new FakeModel("ingredient-parse.v2", answer);
    await parseLine(LINE, { ontology, llm: model, cache });
    expect(model.requests).toHaveLength(1);
  });

  it("lets a bumped prompt re-ask a line the old prompt rejected as not an ingredient", async () => {
    const cache = new InMemoryParseCache();
    cache.load([[cacheKey(LINE), entry("ingredient-parse.v1", [])]]);
    const model = new FakeModel("ingredient-parse.v2", answer);
    const parsed = await parseLine(LINE, { ontology, llm: model, cache });
    expect(model.requests).toHaveLength(1);
    expect(parsed.stage).toBe("llm");
  });

  it("uses an answer from the same prompt version, and from a newer one", async () => {
    for (const written of ["ingredient-parse.v2", "ingredient-parse.v3"]) {
      const cache = new InMemoryParseCache();
      cache.load([[cacheKey(LINE), entry(written, [])]]);
      const model = new FakeModel("ingredient-parse.v2", answer);
      await parseLine(LINE, { ontology, llm: model, cache });
      expect(model.requests, written).toHaveLength(0);
    }
  });

  it("treats an answer with no recorded version as stale", async () => {
    const cache = new InMemoryParseCache();
    cache.load([[cacheKey(LINE), entry(null, [])]]);
    const model = new FakeModel("ingredient-parse.v1", answer);
    await parseLine(LINE, { ontology, llm: model, cache });
    expect(model.requests).toHaveLength(1);
  });

  it("rewrites the entry under the new version, so the next run is a hit", async () => {
    const cache = new InMemoryParseCache();
    cache.load([[cacheKey(LINE), entry("ingredient-parse.v1", [])]]);
    const model = new FakeModel("ingredient-parse.v2", answer);
    await parseLine(LINE, { ontology, llm: model, cache });
    await parseLine(LINE, { ontology, llm: model, cache });
    expect(model.requests).toHaveLength(1);
    expect(cache.entries().find(([k]) => k === cacheKey(LINE))?.[1].promptVersion).toBe(
      "ingredient-parse.v2",
    );
  });
});

describe("isCurrentPromptVersion", () => {
  it("compares the prompt name and version number", () => {
    expect(isCurrentPromptVersion("ingredient-parse.v1", "ingredient-parse.v1")).toBe(true);
    expect(isCurrentPromptVersion("ingredient-parse.v10", "ingredient-parse.v9")).toBe(true);
    expect(isCurrentPromptVersion("ingredient-parse.v2", "ingredient-parse.v10")).toBe(false);
    expect(isCurrentPromptVersion("other.v5", "ingredient-parse.v1")).toBe(false);
    expect(isCurrentPromptVersion(null, "ingredient-parse.v1")).toBe(false);
    expect(isCurrentPromptVersion("garbage", "ingredient-parse.v1")).toBe(false);
    // Anything that is exactly the current id is current, even a stand-in used in tests.
    expect(isCurrentPromptVersion("stand-in", "stand-in")).toBe(true);
  });
});

describe("createAnthropicParseClient over @mp/llm", () => {
  const usage = { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0 };

  function sdk(responses: Array<{ parsed_output: unknown; stop_reason?: string } | Error>) {
    const calls: Array<Record<string, unknown>> = [];
    const client: MessagesParseLike = {
      messages: {
        async parse(params) {
          calls.push(params);
          const next = responses.shift();
          if (!next) throw new Error("out of responses");
          if (next instanceof Error) throw next;
          return {
            parsed_output: next.parsed_output,
            stop_reason: next.stop_reason ?? "end_turn",
            usage,
          };
        },
      },
    };
    return { client, calls };
  }

  it("retries once on a schema failure and bills both calls", async () => {
    const good = {
      lines: [{ index: 0, items: [item({ qty: 1, unit: "cup", ingredient: "flour" })] }],
    };
    const { client, calls } = sdk([{ parsed_output: { nope: 1 } }, { parsed_output: good }]);
    const result = await createAnthropicParseClient({ client }).parseBatch(["1 cup flour"]);
    expect(calls).toHaveLength(2);
    expect(result.byIndex.get(0)?.[0]?.ingredient).toBe("flour");
    expect(result.usage).toMatchObject({ inputTokens: 2000, outputTokens: 200, ok: true });
  });

  it("reports the tokens of every billed call when the answer stays invalid", async () => {
    const { client } = sdk([{ parsed_output: { nope: 1 } }, { parsed_output: { nope: 2 } }]);
    const error = await createAnthropicParseClient({ client })
      .parseBatch(["x"])
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "LlmParseError", code: "invalid" });
    expect((error as { usage: { inputTokens: number; ok: boolean } }).usage).toMatchObject({
      inputTokens: 2000,
      ok: false,
    });
  });

  it("without a key and without a client reports an api error rather than throwing something else", async () => {
    const error = await createAnthropicParseClient({ apiKey: "" })
      .parseBatch(["x"])
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "LlmParseError", code: "api" });
  });
});
