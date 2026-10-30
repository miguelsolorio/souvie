import { ParsedIngredientSchema } from "@mp/core";
import { describe, expect, it } from "vitest";
import { ingredientId } from "../../../supabase/seed/load.ts";
import { seedOntology } from "../evals/seed-ontology";
import {
  type AliasProposal,
  InMemoryOntology,
  InMemoryParseCache,
  type LlmBatchResult,
  type LlmItem,
  type LlmParseClient,
  type ParserDeps,
  parseLine,
  parseLines,
  parseLinesGrouped,
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

/** A model stand-in that answers from a table and records every request. */
class FakeModel implements LlmParseClient {
  readonly model = "fake-haiku";
  readonly promptVersion = "test";
  readonly requests: string[][] = [];
  failWith: Error | null = null;
  constructor(private readonly answers: (line: string) => LlmItem[]) {}

  async parseBatch(lines: readonly string[]): Promise<LlmBatchResult> {
    this.requests.push([...lines]);
    if (this.failWith) throw this.failWith;
    const byIndex = new Map<number, LlmItem[]>();
    lines.forEach((line, i) => {
      byIndex.set(i, this.answers(line));
    });
    return {
      byIndex,
      usage: {
        model: this.model,
        promptVersion: this.promptVersion,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 0,
        latencyMs: 5,
        ok: true,
        lines: lines.length,
      },
    };
  }
}

class Sink {
  readonly proposals: AliasProposal[] = [];
  async record(p: AliasProposal): Promise<void> {
    this.proposals.push(p);
  }
}

describe("named parses (WS03 acceptance 7)", () => {
  it('"salt and pepper to taste" gives salt and black pepper, both split from the line', async () => {
    const line = "salt and pepper to taste";
    const grouped = await parseLinesGrouped([line], { ontology });
    expect(grouped[0]).toHaveLength(2);
    const [salt, pepper] = grouped[0] ?? [];
    expect(salt).toMatchObject({
      rawText: line,
      qty: null,
      unit: null,
      ingredientName: "salt",
      ingredientId: ingredientId("salt"),
      prepNote: "to taste",
      optional: false,
      splitFrom: line,
    });
    expect(pepper).toMatchObject({
      ingredientName: "black pepper",
      ingredientId: ingredientId("black pepper"),
      prepNote: "to taste",
      splitFrom: line,
    });
    expect(salt?.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("parseLine returns the first of a split line and parseLines returns every ingredient", async () => {
    const first = await parseLine("salt and pepper to taste", { ontology });
    expect(first.ingredientName).toBe("salt");
    expect(first.splitFrom).toBe("salt and pepper to taste");
    const flat = await parseLines(["salt and pepper to taste", "2 cups flour"], { ontology });
    expect(flat.map((p) => p.ingredientName)).toEqual([
      "salt",
      "black pepper",
      "all-purpose flour",
    ]);
  });

  it('"1 (14 oz) can diced tomatoes" is 14 oz of diced tomatoes', async () => {
    const p = await parseLine("1 (14 oz) can diced tomatoes", { ontology });
    expect(p).toMatchObject({
      qty: 14,
      unit: "oz",
      ingredientName: "diced tomatoes",
      ingredientId: ingredientId("diced tomatoes"),
      optional: false,
    });
    expect(p.prepNote ?? null).toBeNull();
    expect(p.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('"2-3 large eggs" is a range of large eggs', async () => {
    const p = await parseLine("2-3 large eggs", { ontology });
    expect(p).toMatchObject({
      qty: 2,
      qtyMax: 3,
      unit: "large",
      ingredientName: "egg",
      ingredientId: ingredientId("egg"),
    });
  });

  it('"½ cup packed brown sugar, divided" keeps both preparation words', async () => {
    const p = await parseLine("½ cup packed brown sugar, divided", { ontology });
    expect(p).toMatchObject({
      qty: 0.5,
      unit: "cup",
      ingredientName: "brown sugar",
      ingredientId: ingredientId("brown sugar"),
      prepNote: "packed, divided",
      optional: false,
    });
  });

  it('"2 cups diced yellow onion" separates the preparation from the name', async () => {
    const p = await parseLine("2 cups diced yellow onion", { ontology });
    expect(p).toMatchObject({
      qty: 2,
      unit: "cup",
      ingredientName: "yellow onion",
      prepNote: "diced",
      stage: "grammar",
    });
    expect(p.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("every result satisfies the zod contract", async () => {
    const lines = [
      "2 cups diced yellow onion",
      "1 (14 oz) can diced tomatoes",
      "salt and pepper to taste",
      "1 tablespoon gochugaru",
      "For the sauce:",
      "",
    ];
    for (const p of await parseLines(lines, { ontology })) {
      expect(() => ParsedIngredientSchema.parse(p)).not.toThrow();
    }
  });
});

describe("unknown ingredients (WS03 acceptance 8)", () => {
  it("gochugaru gets a null id, keeps its name, and is proposed", async () => {
    const sink = new Sink();
    const p = await parseLine("1 tablespoon gochugaru", { ontology, proposals: sink });
    expect(p).toMatchObject({
      ingredientId: null,
      ingredientName: "gochugaru",
      qty: 1,
      unit: "tbsp",
    });
    expect(p.confidence).toBeLessThan(0.8);
    expect(sink.proposals).toEqual([
      { rawText: "1 tablespoon gochugaru", proposedName: "gochugaru", proposedCategory: null },
    ]);
  });

  it("proposes each unknown name once per run", async () => {
    const sink = new Sink();
    await parseLines(["1 tbsp gochugaru", "2 tsp gochugaru", "1 cup freekeh"], {
      ontology,
      proposals: sink,
    });
    expect(sink.proposals.map((p) => p.proposedName)).toEqual(["gochugaru", "freekeh"]);
  });

  it("does not propose headers, blank lines, or matched ingredients", async () => {
    const sink = new Sink();
    await parseLines(["For the sauce:", "", "2 cups flour"], { ontology, proposals: sink });
    expect(sink.proposals).toEqual([]);
  });

  it("passes the model's category into the proposal", async () => {
    const sink = new Sink();
    const model = new FakeModel(() => [
      item({
        qty: 1,
        unit: "tbsp",
        ingredient: "gochugaru",
        category: "international",
        prep: null,
      }),
    ]);
    const p = await parseLine("1 tablespoon gochugaru", { ontology, llm: model, proposals: sink });
    expect(p).toMatchObject({ stage: "llm", ingredientId: null, ingredientName: "gochugaru" });
    expect(sink.proposals[0]).toMatchObject({
      proposedName: "gochugaru",
      proposedCategory: "international",
    });
  });
});

describe("model fallback", () => {
  const hard = (n: number): string[] =>
    Array.from({ length: n }, (_, i) => `${i + 1} ${["blorp", "zorb", "quix"][i % 3]}${i} powder`);

  it("never calls the model for lines the grammar and lookup are sure about", async () => {
    const model = new FakeModel(() => []);
    await parseLines(["2 cups flour", "1 tsp salt", "3 cloves garlic, minced"], {
      ontology,
      llm: model,
    });
    expect(model.requests).toHaveLength(0);
  });

  it("batches low-confidence lines 20 at a time", async () => {
    const model = new FakeModel((line) => [
      item({ qty: 1, unit: "each", ingredient: `thing ${line.length}` }),
    ]);
    await parseLines(hard(45), { ontology, llm: model });
    expect(model.requests.map((r) => r.length)).toEqual([20, 20, 5]);
  });

  it("replaces a low-confidence guess with the model's answer, and resolves its name", async () => {
    const model = new FakeModel(() => [
      item({ qty: 2, unit: "tbsp", ingredient: "scallion", prep: "chopped", confidence: 0.92 }),
    ]);
    const p = await parseLine("2 tbsp chopped whatchamacallit", { ontology, llm: model });
    expect(p).toMatchObject({
      stage: "llm",
      qty: 2,
      unit: "tbsp",
      ingredientName: "green onion",
      ingredientId: ingredientId("green onion"),
      prepNote: "chopped",
    });
    expect(p.confidence).toBeLessThanOrEqual(0.95);
  });

  it("caps confidence when the model's ingredient is not in the ontology", async () => {
    const model = new FakeModel(() => [
      item({ qty: 1, unit: "cup", ingredient: "blorpberry", confidence: 0.99 }),
    ]);
    const p = await parseLine("1 cup blorpberry", { ontology, llm: model });
    expect(p.ingredientId).toBeNull();
    expect(p.confidence).toBeLessThanOrEqual(0.6);
  });

  it("returns several items when the model splits a line", async () => {
    const model = new FakeModel(() => [
      item({ ingredient: "salt", prep: "to taste" }),
      item({ ingredient: "black pepper", prep: "to taste" }),
    ]);
    const grouped = await parseLinesGrouped(["zorb and quix to taste"], { ontology, llm: model });
    expect(grouped[0]?.map((p) => p.ingredientName)).toEqual(["salt", "black pepper"]);
    expect(grouped[0]?.every((p) => p.splitFrom === "zorb and quix to taste")).toBe(true);
  });

  it("keeps the deterministic guess and reports the error when the model fails", async () => {
    const model = new FakeModel(() => []);
    model.failWith = new Error("overloaded");
    const errors: unknown[] = [];
    const sink = new Sink();
    const p = await parseLine("1 tablespoon gochugaru", {
      ontology,
      llm: model,
      proposals: sink,
      onLlmError: (e) => errors.push(e),
    });
    expect(p).toMatchObject({ stage: "grammar", ingredientName: "gochugaru", ingredientId: null });
    expect(errors).toHaveLength(1);
    expect(sink.proposals).toHaveLength(1);
  });

  it("ignores a model answer with no usable ingredient", async () => {
    const model = new FakeModel(() => [item({ ingredient: null, confidence: 0 })]);
    const p = await parseLine("1 tablespoon gochugaru", { ontology, llm: model });
    expect(p.stage).toBe("grammar");
  });

  it("reports every call to onLlmRun", async () => {
    const model = new FakeModel(() => [item({ ingredient: "salt" })]);
    const runs: number[] = [];
    await parseLines(hard(25), { ontology, llm: model, onLlmRun: (u) => void runs.push(u.lines) });
    expect(runs).toEqual([20, 5]);
  });
});

describe("cache (WS03 acceptance 5)", () => {
  it("makes zero model calls the second time", async () => {
    const model = new FakeModel(() => [item({ qty: 1, unit: "each", ingredient: "salt" })]);
    const cache = new InMemoryParseCache();
    const deps: ParserDeps = { ontology, llm: model, cache };
    const lines = ["1 blorp", "2 zorb", "3 quix"];

    await parseLines(lines, deps);
    expect(model.requests).toHaveLength(1);
    expect(cache.size).toBe(3);

    const again = await parseLines(lines, deps);
    expect(model.requests).toHaveLength(1);
    expect(again.map((p) => p.stage)).toEqual(["llm", "llm", "llm"]);
  });

  it("keys on normalized text, so spelling variants share an entry", async () => {
    const model = new FakeModel(() => [item({ qty: 0.5, unit: "cup", ingredient: "blorpberry" })]);
    const cache = new InMemoryParseCache();
    await parseLine("½ cup blorpberry", { ontology, llm: model, cache });
    await parseLine("1/2 CUP  blorpberry.", { ontology, llm: model, cache });
    expect(model.requests).toHaveLength(1);
  });

  it("sends a repeated line once per run", async () => {
    const model = new FakeModel(() => [item({ ingredient: "blorpberry" })]);
    await parseLines(["1 blorpberry", "1 blorpberry", "1 Blorpberry"], { ontology, llm: model });
    expect(model.requests.flat()).toHaveLength(1);
  });

  it("looks the ingredient up again on a cache hit, so new ontology entries apply", async () => {
    const model = new FakeModel(() => [item({ qty: 1, unit: "tbsp", ingredient: "gochugaru" })]);
    const cache = new InMemoryParseCache();
    const first = await parseLine("1 tbsp gochugaru", { ontology, llm: model, cache });
    expect(first.ingredientId).toBeNull();

    const grown = new InMemoryOntology({
      ingredients: [
        {
          ingredientId: "11111111-1111-4111-8111-111111111111",
          name: "gochugaru",
          category: "international",
        },
      ],
      aliases: [],
    });
    const second = await parseLine("1 tbsp gochugaru", { ontology: grown, llm: model, cache });
    expect(model.requests).toHaveLength(1);
    expect(second).toMatchObject({
      ingredientId: "11111111-1111-4111-8111-111111111111",
      ingredientName: "gochugaru",
    });
  });

  it("does not cache lines the model failed on", async () => {
    const model = new FakeModel(() => []);
    model.failWith = new Error("boom");
    const cache = new InMemoryParseCache();
    await parseLine("1 tbsp gochugaru", { ontology, llm: model, cache });
    expect(cache.size).toBe(0);
  });
});
