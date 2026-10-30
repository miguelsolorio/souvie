// Review fixes (WS03 fix round): headers, negative caching, T vs t cache keys, side effects that
// fail after the model was paid, prototype-property words, and quantities that are not numbers.

import { ParsedIngredientSchema } from "@mp/core";
import { describe, expect, it } from "vitest";
import { seedOntology } from "../evals/seed-ontology";
import {
  type CachedParse,
  InMemoryParseCache,
  type LlmBatchResult,
  type LlmItem,
  type LlmParseClient,
  type LlmUsage,
  type ParseCache,
  type ParserDeps,
  parseLine,
  parseLines,
  parseLinesGrouped,
} from "./index";

const ontology = seedOntology();

const usage = (lines: number): LlmUsage => ({
  model: "fake-haiku",
  promptVersion: "test",
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  latencyMs: 1,
  ok: true,
  lines,
});

const item = (partial: Partial<LlmItem>): LlmItem => ({
  qty: null,
  qty_max: null,
  unit: null,
  ingredient: null,
  category: null,
  prep: null,
  optional: false,
  confidence: 0.9,
  ...partial,
});

/** Answers every line it is sent with `answer(line)`, or skips lines when `answer` returns undefined. */
class Model implements LlmParseClient {
  readonly model = "fake-haiku";
  readonly promptVersion = "test";
  readonly requests: string[][] = [];
  constructor(private readonly answer: (line: string) => LlmItem[] | undefined) {}

  async parseBatch(lines: readonly string[]): Promise<LlmBatchResult> {
    this.requests.push([...lines]);
    const byIndex = new Map<number, LlmItem[]>();
    lines.forEach((line, i) => {
      const items = this.answer(line);
      if (items) byIndex.set(i, items);
    });
    return { byIndex, usage: usage(lines.length) };
  }

  get sent(): string[] {
    return this.requests.flat();
  }
}

const warnings = () => {
  const seen: { message: string; error: unknown }[] = [];
  return {
    seen,
    onWarning: (message: string, error: unknown) => void seen.push({ message, error }),
  };
};

describe("headers and blank lines never reach the model", () => {
  const lines = [
    "For the sauce:",
    "",
    "   ",
    "Marinade:",
    "Toppings:",
    "For the crust",
    "2 cups flour",
  ];

  it("sends nothing, and gives them confidence 0 so a caller can drop them", async () => {
    const model = new Model(() => [item({ ingredient: "salt" })]);
    const grouped = await parseLinesGrouped(lines, { ontology, llm: model });
    expect(model.requests).toHaveLength(0);
    for (let i = 0; i < 6; i++) {
      expect(grouped[i]).toHaveLength(1);
      expect(grouped[i]?.[0]).toMatchObject({
        confidence: 0,
        ingredientId: null,
        ingredientName: null,
      });
    }
    expect(grouped[6]?.[0]?.ingredientName).toBe("all-purpose flour");
  });

  it("keeps them out of the model next to uncertain lines, on a first and a second pass", async () => {
    const model = new Model(() => [item({ qty: 1, unit: "each", ingredient: "blorpberry" })]);
    const cache = new InMemoryParseCache();
    const deps: ParserDeps = { ontology, llm: model, cache };
    const mixed = ["For the sauce:", "1 blorp", "", "Marinade:"];

    await parseLines(mixed, deps);
    expect(model.sent).toEqual(["1 blorp"]);

    await parseLines(mixed, deps);
    expect(model.requests).toHaveLength(1);
  });

  it("does not propose a header as an unknown ingredient", async () => {
    const proposed: string[] = [];
    await parseLines(lines, {
      ontology,
      proposals: { record: async (p) => void proposed.push(p.proposedName) },
    });
    expect(proposed).toEqual([]);
  });
});

describe("a line the model rejects is cached, so it is not sent again", () => {
  it("caches an answer whose items have no ingredient", async () => {
    const model = new Model(() => [item({ ingredient: null, confidence: 0 })]);
    const cache = new InMemoryParseCache();
    const deps: ParserDeps = { ontology, llm: model, cache };

    const first = await parseLine("1 tablespoon gochugaru", deps);
    expect(model.requests).toHaveLength(1);
    expect(cache.size).toBe(1);
    // The caller still gets the deterministic guess.
    expect(first).toMatchObject({
      stage: "grammar",
      ingredientName: "gochugaru",
      ingredientId: null,
    });

    const second = await parseLine("1 tablespoon gochugaru", deps);
    expect(model.requests).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it("caches an answer with an empty item list", async () => {
    const model = new Model(() => []);
    const cache = new InMemoryParseCache();
    await parseLines(["1 blorp", "2 zorb"], { ontology, llm: model, cache });
    expect(cache.size).toBe(2);
    await parseLines(["1 blorp", "2 zorb"], { ontology, llm: model, cache });
    expect(model.requests).toHaveLength(1);
  });

  it("stores the rejection with the model and prompt version", async () => {
    const model = new Model(() => []);
    const cache = new InMemoryParseCache();
    await parseLine("1 blorp", { ontology, llm: model, cache });
    const [entry] = cache.entries();
    expect(entry?.[1]).toMatchObject({
      items: [],
      source: "llm",
      model: "fake-haiku",
      promptVersion: "test",
    });
  });

  it("does not cache a line the model skipped, so the next run asks again", async () => {
    const model = new Model(() => undefined);
    const cache = new InMemoryParseCache();
    await parseLine("1 blorp", { ontology, llm: model, cache });
    expect(cache.size).toBe(0);
    await parseLine("1 blorp", { ontology, llm: model, cache });
    expect(model.requests).toHaveLength(2);
  });
});

describe("T and t are different units, so they are different cache keys", () => {
  it("does not answer '1 t blorp' from the entry for '1 T blorp'", async () => {
    const model = new Model((line) => [
      item({ qty: 1, unit: line.includes(" T ") ? "tbsp" : "tsp", ingredient: "blorpberry" }),
    ]);
    const cache = new InMemoryParseCache();
    const deps: ParserDeps = { ontology, llm: model, cache };

    const big = await parseLine("1 T blorp", deps);
    const small = await parseLine("1 t blorp", deps);

    expect(model.sent).toEqual(["1 T blorp", "1 t blorp"]);
    expect(cache.size).toBe(2);
    expect(big.unit).toBe("tbsp");
    expect(small.unit).toBe("tsp");
    // Each now comes back from its own entry.
    expect((await parseLine("1 T blorp", deps)).unit).toBe("tbsp");
    expect((await parseLine("1 t blorp", deps)).unit).toBe("tsp");
    expect(model.requests).toHaveLength(2);
  });

  it("still shares an entry between spellings that mean the same thing", async () => {
    const model = new Model(() => [item({ qty: 1, unit: "tbsp", ingredient: "blorpberry" })]);
    const cache = new InMemoryParseCache();
    await parseLine("1 TBSP blorp", { ontology, llm: model, cache });
    await parseLine("1 tbsp Blorp.", { ontology, llm: model, cache });
    expect(model.requests).toHaveLength(1);
  });
});

describe("a failing side effect does not abort a parse that is already paid for", () => {
  const unknownLines = ["1 tablespoon gochugaru", "1 cup freekeh"];

  it("logs a failing proposal sink and still records the next proposal", async () => {
    const w = warnings();
    const attempts: string[] = [];
    const results = await parseLines(unknownLines, {
      ontology,
      onWarning: w.onWarning,
      proposals: {
        record: async (p) => {
          attempts.push(p.proposedName);
          if (p.proposedName === "gochugaru") throw new Error("db down");
        },
      },
    });
    expect(results.map((r) => r.ingredientName)).toEqual(["gochugaru", "freekeh"]);
    expect(attempts).toEqual(["gochugaru", "freekeh"]);
    expect(w.seen).toHaveLength(1);
    expect(w.seen[0]?.message).toContain("gochugaru");
    expect(w.seen[0]?.error).toEqual(new Error("db down"));
  });

  it("falls back to console.warn when no onWarning is given", async () => {
    const original = console.warn;
    const calls: unknown[][] = [];
    console.warn = (...args: unknown[]) => void calls.push(args);
    try {
      await parseLine("1 tablespoon gochugaru", {
        ontology,
        proposals: {
          record: async () => {
            throw new Error("nope");
          },
        },
      });
    } finally {
      console.warn = original;
    }
    expect(calls).toHaveLength(1);
  });

  it("keeps the model's answer when the cache write fails", async () => {
    const w = warnings();
    const model = new Model(() => [
      item({ qty: 1, unit: "cup", ingredient: "scallion", confidence: 0.9 }),
    ]);
    const cache: ParseCache = {
      getMany: async () => new Map<string, CachedParse>(),
      putMany: async () => {
        throw new Error("cache down");
      },
    };
    const p = await parseLine("1 cup blorp", {
      ontology,
      llm: model,
      cache,
      onWarning: w.onWarning,
    });
    expect(p).toMatchObject({ stage: "llm", ingredientName: "green onion" });
    expect(w.seen.map((x) => x.message)).toEqual(["parse cache write failed"]);
  });

  it("treats a failing cache read as a miss and still asks the model", async () => {
    const w = warnings();
    const model = new Model(() => [item({ qty: 1, unit: "cup", ingredient: "scallion" })]);
    const cache: ParseCache = {
      getMany: async () => {
        throw new Error("cache down");
      },
      putMany: async () => undefined,
    };
    const p = await parseLine("1 cup blorp", {
      ontology,
      llm: model,
      cache,
      onWarning: w.onWarning,
    });
    expect(p.stage).toBe("llm");
    expect(model.requests).toHaveLength(1);
    expect(w.seen).toHaveLength(1);
  });

  it("keeps the model's answer when run logging throws", async () => {
    const w = warnings();
    const model = new Model(() => [item({ qty: 1, unit: "cup", ingredient: "scallion" })]);
    const p = await parseLine("1 cup blorp", {
      ontology,
      llm: model,
      onWarning: w.onWarning,
      onLlmRun: () => {
        throw new Error("ai_runs down");
      },
    });
    expect(p.stage).toBe("llm");
    expect(w.seen).toHaveLength(1);
  });
});

describe("words that are also Object.prototype properties", () => {
  const odd = ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"];

  it("parses a batch with one odd line, marks it low confidence, and throws nothing", async () => {
    const lines = ["2 cups flour", "1 constructor flour", "3 eggs"];
    const grouped = await parseLinesGrouped(lines, { ontology });
    expect(grouped).toHaveLength(3);
    expect(grouped[0]?.[0]?.ingredientName).toBe("all-purpose flour");
    expect(grouped[2]?.[0]?.ingredientName).toBe("egg");
    const odder = grouped[1]?.[0];
    expect(odder).toBeDefined();
    expect(odder?.confidence).toBeLessThan(0.8);
    expect(odder?.ingredientId).toBeNull();
  });

  it.each(odd)("does not throw on '1 %s flour' in any position", async (word) => {
    const lines = [`1 ${word} flour`, `${word}`, `2 cups ${word}`, `${word} to taste`, `1 ${word}`];
    const results = await parseLines(lines, { ontology });
    expect(results.length).toBeGreaterThanOrEqual(lines.length);
    for (const r of results) expect(() => ParsedIngredientSchema.parse(r)).not.toThrow();
    for (const r of results) expect(r.confidence).toBeLessThan(0.8);
  });

  it("never reads a prototype property as a unit", async () => {
    const p = await parseLine("1 constructor flour", { ontology });
    expect(p.unit).toBe("each");
  });
});

describe("a quantity that is not a number", () => {
  it("'1/0 cup flour' has no quantity and low confidence", async () => {
    const p = await parseLine("1/0 cup flour", { ontology });
    expect(p.qty).toBeNull();
    expect(p.qtyMax ?? null).toBeNull();
    expect(p.confidence).toBeLessThan(0.8);
    expect(() => ParsedIngredientSchema.parse(p)).not.toThrow();
  });

  it("sends such a line to the model like any other uncertain line", async () => {
    const model = new Model(() => [item({ qty: 1, unit: "cup", ingredient: "flour" })]);
    const p = await parseLine("1/0 cup flour", { ontology, llm: model });
    expect(model.requests).toHaveLength(1);
    expect(p.stage).toBe("llm");
  });

  it("never returns Infinity or NaN for odd quantity text", async () => {
    const lines = [
      "1 1/0 cups flour",
      "0/0 tsp salt",
      `${"9".repeat(400)} cups flour`,
      "2 to 1/0 cups flour",
    ];
    for (const r of await parseLines(lines, { ontology })) {
      for (const n of [r.qty, r.qtyMax ?? null])
        if (n !== null) expect(Number.isFinite(n)).toBe(true);
      expect(() => ParsedIngredientSchema.parse(r)).not.toThrow();
    }
  });
});
