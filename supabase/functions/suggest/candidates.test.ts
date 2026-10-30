import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Candidate,
  fetchCandidates,
  mainIngredientsOf,
  pickCalibration,
  scoreCandidate,
  toCalibrationCard,
} from "./candidates.ts";
import { buildFilterSpec } from "./filters.ts";
import {
  FIXTURE_HOUSEHOLD,
  FIXTURE_USER,
  type LoadedCorpus,
  loadCorpus,
} from "./testing/corpus.ts";
import { createTestDb, type TestDb, vectorLiteral } from "./testing/db.ts";

const NOW = new Date("2026-10-30T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

describe("scoreCandidate", () => {
  const base = { similarity: 0.5, cuisine: "thai", visibility: "household" as const, id: "r1" };

  it("starts from similarity and adds a bonus for the household's own recipes", () => {
    const score = scoreCandidate(base, { cuisines: [], history: new Map(), now: NOW });
    expect(score).toBeCloseTo(0.55, 5);
    const catalog = scoreCandidate(
      { ...base, visibility: "catalog" },
      { cuisines: [], history: new Map(), now: NOW },
    );
    expect(catalog).toBeCloseTo(0.5, 5);
  });

  it("rewards the favorite cuisine, matched without regard to case", () => {
    const withCuisine = scoreCandidate(base, { cuisines: ["Thai"], history: new Map(), now: NOW });
    const without = scoreCandidate(base, { cuisines: ["italian"], history: new Map(), now: NOW });
    expect(withCuisine - without).toBeCloseTo(0.12, 5);
  });

  it("works with no similarity at all (a cold profile)", () => {
    const score = scoreCandidate(
      { ...base, similarity: null },
      { cuisines: ["thai"], history: new Map(), now: NOW },
    );
    expect(score).toBeCloseTo(0.17, 5);
  });

  it("boosts likes, penalizes skips, and uses popularity", () => {
    const history = new Map([
      ["r1", { likes: 1, skips: 0, lastCookedAt: null, popularity: 0 }],
      ["r2", { likes: 0, skips: 1, lastCookedAt: null, popularity: 0 }],
      ["r3", { likes: 0, skips: 0, lastCookedAt: null, popularity: 50 }],
    ]);
    const ctx = { cuisines: [], history, now: NOW };
    const plain = scoreCandidate({ ...base, id: "x" }, ctx);
    expect(scoreCandidate(base, ctx) - plain).toBeCloseTo(0.08, 5);
    expect(scoreCandidate({ ...base, id: "r2" }, ctx) - plain).toBeCloseTo(-0.05, 5);
    expect(scoreCandidate({ ...base, id: "r3" }, ctx) - plain).toBeCloseTo(0.08, 5);
  });

  it("caps the like and skip effect at two", () => {
    const history = new Map([["r1", { likes: 9, skips: 0, lastCookedAt: null, popularity: 0 }]]);
    const ctx = { cuisines: [], history, now: NOW };
    expect(scoreCandidate(base, ctx) - scoreCandidate({ ...base, id: "x" }, ctx)).toBeCloseTo(
      0.16,
      5,
    );
  });

  it("penalizes dinners cooked in the last four weeks, more for the last two", () => {
    const at = (days: number) =>
      new Map([
        [
          "r1",
          { likes: 0, skips: 0, lastCookedAt: new Date(NOW.getTime() - days * DAY), popularity: 0 },
        ],
      ]);
    const plain = scoreCandidate(
      { ...base, id: "x" },
      { cuisines: [], history: new Map(), now: NOW },
    );
    expect(scoreCandidate(base, { cuisines: [], history: at(7), now: NOW }) - plain).toBeCloseTo(
      -0.25,
      5,
    );
    expect(scoreCandidate(base, { cuisines: [], history: at(20), now: NOW }) - plain).toBeCloseTo(
      -0.1,
      5,
    );
    expect(scoreCandidate(base, { cuisines: [], history: at(40), now: NOW }) - plain).toBeCloseTo(
      0,
      5,
    );
  });
});

describe("pickCalibration", () => {
  const item = (id: string, cuisine: string | null) => ({ id, cuisine });
  const ranked = [
    item("a1", "italian"),
    item("a2", "italian"),
    item("a3", "italian"),
    item("t1", "thai"),
    item("t2", "thai"),
    item("m1", "mexican"),
    item("n1", null),
  ];

  it("takes the best of each cuisine first, then fills in rank order", () => {
    const picked = pickCalibration(ranked, 5, 1).map((i) => i.id);
    expect(picked).toEqual(["a1", "t1", "m1", "n1", "a2"]);
  });

  it("allows two of a cuisine by default", () => {
    const picked = pickCalibration(ranked, 6).map((i) => i.id);
    expect(picked.filter((id) => id.startsWith("a"))).toHaveLength(2);
    expect(picked).toHaveLength(6);
  });

  it("returns fewer when there are fewer, and never repeats", () => {
    const picked = pickCalibration(ranked.slice(0, 2), 12);
    expect(picked.map((i) => i.id)).toEqual(["a1", "a2"]);
    expect(new Set(pickCalibration(ranked, 12).map((i) => i.id)).size).toBe(ranked.length);
    expect(pickCalibration([], 12)).toEqual([]);
  });
});

describe("mainIngredientsOf", () => {
  it("skips pantry staples and duplicates, prefers parsed names, and stops at six", () => {
    const line = (rawText: string, ingredientName: string | null, staple = false) => ({
      rawText,
      ingredientName,
      category: null,
      staple,
    });
    const names = mainIngredientsOf([
      line("2 tbsp olive oil", "olive oil", true),
      line("1 lb chicken thighs", "chicken thighs"),
      line("2 cups Rice", "rice"),
      line("1 cup rice, rinsed", "rice"),
      line("3 cloves garlic", "garlic"),
      line("a handful of kale", null),
      line("1 lemon", "lemon"),
      line("1 onion", "onion"),
      line("1 carrot", "carrot"),
    ]);
    expect(names).toEqual([
      "chicken thighs",
      "rice",
      "garlic",
      "a handful of kale",
      "lemon",
      "onion",
    ]);
  });
});

describe("toCalibrationCard", () => {
  it("shows the recipe's own title and description, trims tags, and takes the resolved image", () => {
    const candidate: Candidate = {
      id: "c77e0000-0000-4000-8000-000000000001",
      householdId: null,
      visibility: "catalog",
      title: "Sheet pan chicken",
      description: "Easy.",
      imageUrl: "recipe-images/x.jpg",
      sourceUrl: "https://example.com/recipe",
      cuisine: "american",
      tags: ["a", "b", "c", "d", "e", "f", "g", "h"],
      servings: 4,
      totalMin: 35,
      similarity: null,
      score: 0,
      mainIngredients: [],
    };
    const card = toCalibrationCard(candidate, "https://signed.example/x.jpg");
    expect(card).toMatchObject({
      recipeId: candidate.id,
      title: "Sheet pan chicken",
      description: "Easy.",
      imageUrl: "https://signed.example/x.jpg",
      sourceUrl: "https://example.com/recipe",
      cuisine: "american",
      totalMin: 35,
    });
    expect(card.tags).toHaveLength(6);
  });
});

describe("fetchCandidates ranking on PGlite", () => {
  let t: TestDb;
  let corpus: LoadedCorpus;

  // Two axes of a tiny embedding space: dimension 0 is "mexican", dimension 1 is "everything else".
  const axis = (cuisine: string | null) => {
    const v = new Array<number>(1024).fill(0);
    v[cuisine === "mexican" ? 0 : 1] = 1;
    return v;
  };

  beforeAll(async () => {
    t = await createTestDb();
    corpus = await loadCorpus(t, { embeddings: (recipe) => axis(recipe.cuisine) });
  }, 60_000);
  afterAll(async () => {
    await t.close();
  });

  const spec = buildFilterSpec({ allergies: [], diets: [], dislikes: [] });

  it("puts the recipes nearest the taste embedding first", async () => {
    const taste = vectorLiteral(axis("mexican"));
    const { candidates } = await fetchCandidates(t.runner, {
      householdId: FIXTURE_HOUSEHOLD,
      spec,
      tasteEmbedding: taste,
      cuisines: [],
      warn: () => {},
    });
    const firstOther = candidates.findIndex((c) => c.cuisine !== "mexican");
    const lastMexican = candidates.map((c) => c.cuisine).lastIndexOf("mexican");
    expect(lastMexican).toBeLessThan(firstOther);
    expect(candidates[0]?.similarity).toBeCloseTo(1, 5);
    expect(candidates.length).toBeLessThanOrEqual(60);
  });

  it("falls back to cuisine and the household bonus on a cold profile", async () => {
    const { candidates } = await fetchCandidates(t.runner, {
      householdId: FIXTURE_HOUSEHOLD,
      spec,
      tasteEmbedding: null,
      cuisines: ["thai"],
      warn: () => {},
    });
    expect(candidates.every((c) => c.similarity === null)).toBe(true);
    expect(candidates[0]?.cuisine).toBe("thai");
  });

  it("pushes down a dinner cooked last week and lifts one the household liked", async () => {
    const tacos = corpus.ids.get("black-bean-tacos");
    const risotto = corpus.ids.get("mushroom-risotto");
    await t.query(
      `insert into public.recipe_feedback (household_id, user_id, recipe_id, signal, created_at)
       values ($1, $2, $3, 'cooked', $5), ($1, $2, $4, 'like', $5)`,
      [
        FIXTURE_HOUSEHOLD,
        FIXTURE_USER,
        tacos,
        risotto,
        new Date(NOW.getTime() - 3 * DAY).toISOString(),
      ],
    );
    const { candidates } = await fetchCandidates(t.runner, {
      householdId: FIXTURE_HOUSEHOLD,
      spec,
      tasteEmbedding: vectorLiteral(axis("mexican")),
      cuisines: [],
      now: NOW,
      warn: () => {},
    });
    const byId = new Map(candidates.map((c, i) => [c.id, { i, c }]));
    const taco = byId.get(tacos ?? "");
    // Both are mexican/other equals otherwise; the cooked one scores 0.25 lower than its twin.
    const twin = candidates.find((c) => c.cuisine === "mexican" && c.id !== tacos && c.score > 0);
    expect(taco).toBeDefined();
    if (taco && twin) expect(taco.c.score).toBeLessThan(twin.score);
    // The liked risotto and any other household recipe on the same axis differ by the like bonus.
    const liked = byId.get(risotto ?? "");
    const peer = candidates.find(
      (c) => c.id !== risotto && c.cuisine === "italian" && c.visibility === "household",
    );
    expect(liked).toBeDefined();
    expect(peer).toBeDefined();
    // A like is worth 0.08, plus its small share of popularity (one like of fifty).
    const popularity = (Math.log1p(1) / Math.log1p(50)) * 0.08;
    if (liked && peer) expect(liked.c.score - peer.score).toBeCloseTo(0.08 + popularity, 5);
  });

  it("still ranks when the feedback table is missing", async () => {
    const warnings: string[] = [];
    await t.exec("alter table public.recipe_feedback rename to recipe_feedback_off");
    try {
      const { candidates } = await fetchCandidates(t.runner, {
        householdId: FIXTURE_HOUSEHOLD,
        spec,
        tasteEmbedding: null,
        cuisines: [],
        warn: (m) => warnings.push(m),
      });
      expect(candidates.length).toBeGreaterThan(0);
      expect(warnings.join(" ")).toMatch(/feedback history unavailable/);
    } finally {
      await t.exec("alter table public.recipe_feedback_off rename to recipe_feedback");
    }
  });

  it("limits and orders deterministically", async () => {
    const run = () =>
      fetchCandidates(t.runner, {
        householdId: FIXTURE_HOUSEHOLD,
        spec,
        tasteEmbedding: null,
        cuisines: [],
        limit: 7,
        warn: () => {},
      });
    const [a, b] = [await run(), await run()];
    expect(a.candidates).toHaveLength(7);
    expect(a.candidates.map((c) => c.id)).toEqual(b.candidates.map((c) => c.id));
  });
});
