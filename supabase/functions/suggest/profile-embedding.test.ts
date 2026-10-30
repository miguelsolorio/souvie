import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EMBEDDING_DIMENSIONS, type MessagesClient } from "../../../packages/llm/src/index.ts";
import {
  blendEmbeddings,
  buildTasteEmbedding,
  embedMissingRecipes,
  parseVector,
  plainTasteSummary,
  recipeEmbeddingText,
  summarizeTaste,
  tasteVarsFrom,
} from "./profile-embedding.ts";
import {
  FIXTURE_HOUSEHOLD,
  type LoadedCorpus,
  loadCorpus,
  OTHER_HOUSEHOLD,
} from "./testing/corpus.ts";
import { createTestDb, type TestDb } from "./testing/db.ts";

const unit = (i: number, size = EMBEDDING_DIMENSIONS) =>
  Array.from({ length: size }, (_, k) => (k === i ? 1 : 0));

describe("recipeEmbeddingText", () => {
  it("is built from title, cuisine, tags, and ingredient names", () => {
    expect(
      recipeEmbeddingText({
        title: "  Black bean tacos ",
        cuisine: "mexican",
        tags: ["dinner", "tacos"],
        ingredients: ["black beans", "avocado"],
      }),
    ).toBe(
      "Black bean tacos | cuisine: mexican | tags: dinner, tacos | ingredients: black beans, avocado",
    );
  });

  it("leaves out what is missing and caps the length", () => {
    expect(recipeEmbeddingText({ title: "Soup", cuisine: null, tags: [], ingredients: [] })).toBe(
      "Soup",
    );
    const long = recipeEmbeddingText({
      title: "x".repeat(3000),
      cuisine: null,
      tags: [],
      ingredients: [],
    });
    expect(long.length).toBe(1500);
  });
});

describe("parseVector", () => {
  it("reads pgvector text of the right size", () => {
    const text = `[${unit(2).join(",")}]`;
    expect(parseVector(text)).toEqual(unit(2));
  });

  it("returns null for nothing, a wrong size, or garbage", () => {
    expect(parseVector(null)).toBeNull();
    expect(parseVector("[1,2,3]")).toBeNull();
    expect(parseVector("not a vector")).toBeNull();
    expect(parseVector(`[${Array.from({ length: 1024 }, () => "x").join(",")}]`)).toBeNull();
  });
});

describe("blendEmbeddings", () => {
  it("returns a unit vector in the direction of the weighted sum", () => {
    const blended = blendEmbeddings([
      { vector: [3, 0], weight: 1 },
      { vector: [0, 10], weight: 1 },
    ]);
    expect(blended).not.toBeNull();
    const [x, y] = blended as number[];
    expect(x).toBeCloseTo(Math.SQRT1_2, 5);
    expect(y).toBeCloseTo(Math.SQRT1_2, 5);
  });

  it("gives a heavier part more of the direction, whatever its length", () => {
    const [x, y] = blendEmbeddings([
      { vector: [100, 0], weight: 0.25 },
      { vector: [0, 1], weight: 0.75 },
    ]) as number[];
    expect((y as number) / (x as number)).toBeCloseTo(3, 4);
  });

  it("is null for nothing, and refuses vectors of different sizes", () => {
    expect(blendEmbeddings([])).toBeNull();
    expect(blendEmbeddings([{ vector: [1, 2], weight: 0 }])).toBeNull();
    expect(() =>
      blendEmbeddings([
        { vector: [1, 2], weight: 1 },
        { vector: [1, 2, 3], weight: 1 },
      ]),
    ).toThrow(/differ in size/);
  });
});

describe("taste text", () => {
  const vars = tasteVarsFrom(
    { cuisines: ["thai"], weeknight_minutes: 30, skill: "beginner", notes: "We like leftovers." },
    ["Pad thai", "Tacos"],
    ["Beef stew"],
  );

  it("builds a readable plain summary from what is known", () => {
    const text = plainTasteSummary(vars);
    expect(text).toContain("Likes thai cooking.");
    expect(text).toContain("Enjoyed Pad thai, Tacos.");
    expect(text).toContain("Passed on Beef stew.");
    expect(text).toContain("about 30 minutes");
    expect(text).not.toContain("—");
  });

  it("never returns an empty summary", () => {
    expect(plainTasteSummary(tasteVarsFrom({}, [], []))).toBe("Everyday home cooking.");
  });

  it("uses the plain summary when no model is available, without calling anything", async () => {
    const result = await summarizeTaste(vars, { householdId: "h" });
    expect(result.source).toBe("plain");
  });

  it("uses Haiku when a client is given, and falls back to plain text when the call fails", async () => {
    const parse = vi.fn(async () => ({
      parsed_output: { summary: "Loves bright Thai and Mexican dinners." },
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 20 },
    }));
    const client: MessagesClient = { messages: { parse } };
    const model = await summarizeTaste(vars, { client, householdId: "h" });
    expect(model).toEqual({ text: "Loves bright Thai and Mexican dinners.", source: "model" });
    expect((parse.mock.calls[0] as unknown as [{ model: string }])[0].model).toBe(
      "claude-haiku-5-5",
    );

    const broken: MessagesClient = {
      messages: {
        parse: async () => {
          throw Object.assign(new Error("overloaded"), { status: 529 });
        },
      },
    };
    const warn = vi.fn();
    const fallback = await summarizeTaste(vars, { client: broken, householdId: "h" }, warn);
    expect(fallback.source).toBe("plain");
    expect(warn).toHaveBeenCalled();
  });
});

describe("buildTasteEmbedding", () => {
  const prefs = { cuisines: ["thai"] };

  it("embeds the summary as a query when there is nothing liked yet", async () => {
    const embed = vi.fn(async () => [unit(0)]);
    const built = await buildTasteEmbedding(
      { preferences: prefs, liked: [], skipped: [] },
      { embed, householdId: "h" },
    );
    expect(embed).toHaveBeenCalledWith([expect.stringContaining("thai")], "query");
    expect(built?.vector).toEqual(unit(0));
    expect(built?.summarySource).toBe("plain");
  });

  it("blends half the liked dinners' average into the summary vector", async () => {
    const embed = vi.fn(async () => [unit(0)]);
    const built = await buildTasteEmbedding(
      {
        preferences: prefs,
        liked: [
          { title: "A", embedding: unit(1) },
          { title: "B", embedding: unit(1) },
          { title: "C", embedding: null },
        ],
        skipped: [],
      },
      { embed, householdId: "h" },
    );
    const vector = built?.vector as number[];
    expect(vector[0]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(vector[1]).toBeCloseTo(Math.SQRT1_2, 5);
    // All three titles reach the summary text even though one has no vector yet.
    const sent = (embed.mock.calls[0] as unknown as [string[]])[0][0] ?? "";
    expect(sent).toContain("A, B, C");
  });

  it("returns null when the service gives back nothing", async () => {
    const built = await buildTasteEmbedding(
      { preferences: prefs, liked: [], skipped: [] },
      { embed: async () => [], householdId: "h" },
    );
    expect(built).toBeNull();
  });
});

describe("embedMissingRecipes", () => {
  let t: TestDb;
  let corpus: LoadedCorpus;
  beforeAll(async () => {
    t = await createTestDb();
    corpus = await loadCorpus(t);
  }, 60_000);
  afterAll(async () => {
    await t.close();
  });

  it("embeds the household's recipes only, in batches, and says how many are left", async () => {
    const seen: string[] = [];
    const embed = async (texts: readonly string[]) => {
      seen.push(...texts);
      return texts.map(() => unit(5));
    };
    const first = await embedMissingRecipes(t.runner, {
      householdId: FIXTURE_HOUSEHOLD,
      limit: 10,
      embed,
    });
    expect(first.embedded).toBe(10);
    expect(first.remaining).toBeGreaterThan(0);
    // Ingredient names are part of the text.
    expect(seen.some((text) => text.includes("ingredients:"))).toBe(true);

    const total = first.embedded + first.remaining;
    const second = await embedMissingRecipes(t.runner, {
      householdId: FIXTURE_HOUSEHOLD,
      limit: 100,
      embed,
    });
    expect(second.embedded).toBe(first.remaining);
    expect(second.remaining).toBe(0);
    expect(first.embedded + second.embedded).toBe(total);

    const stored = await t.query<{ n: number }>(
      "select count(*)::int as n from public.recipes where household_id = $1 and embedding is not null",
      [FIXTURE_HOUSEHOLD],
    );
    expect(stored[0]?.n).toBe(total);
    const other = await t.query<{ n: number }>(
      "select count(*)::int as n from public.recipes where household_id = $1 and embedding is not null",
      [OTHER_HOUSEHOLD],
    );
    expect(other[0]?.n).toBe(0);
    // Catalog recipes belong to nobody's household and are not touched here.
    const catalog = await t.query<{ n: number }>(
      "select count(*)::int as n from public.recipes where household_id is null and embedding is not null",
    );
    expect(catalog[0]?.n).toBe(0);
    expect(corpus.ids.size).toBeGreaterThan(0);
  });

  it("does nothing when every recipe already has a vector", async () => {
    const embed = vi.fn(async (texts: readonly string[]) => texts.map(() => unit(1)));
    const result = await embedMissingRecipes(t.runner, {
      householdId: FIXTURE_HOUSEHOLD,
      limit: 10,
      embed,
    });
    expect(result).toEqual({ embedded: 0, remaining: 0 });
    expect(embed).not.toHaveBeenCalled();
  });
});
