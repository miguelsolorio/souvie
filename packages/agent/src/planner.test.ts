import { DEFAULT_RUN_POLICY } from "@mp/core";
import type { Product } from "@mp/retailers";
import { MockRetailer } from "@mp/retailers/mock";
import { describe, expect, it } from "vitest";
import {
  compareScores,
  needsModel,
  prepareLine,
  proposeItem,
  relevance,
  type ScoringContext,
  scoreCandidates,
  searchQuery,
} from "./planner.ts";
import { storeById } from "./replay.ts";
import { parsePackSize, unitsToBuy } from "./sizes.ts";
import { line, MOCK_STORE_ID, ONTOLOGY, product } from "./testing/fixtures.ts";
import { PlanningSession } from "./tools.ts";
import { Transcript } from "./transcript.ts";
import { NO_PREFERENCES } from "./types.ts";

const thighs = () => line("T1", "Chicken thighs", 2, "lb", ONTOLOGY.chickenThigh);

function ctx(overrides: Partial<ScoringContext> = {}): ScoringContext {
  return {
    pinnedProductId: null,
    pastPickIds: new Set(),
    preferences: NO_PREFERENCES,
    ...overrides,
  };
}

/** A and B, where everything below the factor under test favours B. */
function pair(a: Partial<Product>, b: Partial<Product>): [Product, Product] {
  return [
    product({ id: "A", name: "Alder Chicken Thighs", size: "1 lb", ...a }),
    product({ id: "B", name: "Birch Chicken Thighs", size: "1 lb", ...b }),
  ];
}

function winner(products: Product[], c: ScoringContext): string | undefined {
  const forward = scoreCandidates(thighs(), products, c)[0]?.product.id;
  const backward = scoreCandidates(thighs(), [...products].reverse(), c)[0]?.product.id;
  expect(forward).toBe(backward);
  return forward;
}

describe("scoring order: pinned > past pick > unit-price fit > profile preference > stock", () => {
  const prefersBirch = { ...NO_PREFERENCES, preferredBrands: ["Birch"] };

  it("pinned decides alone: A is pinned, B is the past pick, cheaper, preferred and in stock", () => {
    const [a, b] = pair(
      { price: 5, stockLevel: "LOW", brand: "Alder" },
      { price: 2, stockLevel: "HIGH", brand: "Birch" },
    );
    expect(
      winner(
        [a, b],
        ctx({ pinnedProductId: "A", pastPickIds: new Set(["B"]), preferences: prefersBirch }),
      ),
    ).toBe("A");
  });

  it("past pick decides alone: A is the usual pick, B is cheaper, preferred and in stock", () => {
    const [a, b] = pair(
      { price: 5, stockLevel: "LOW", brand: "Alder" },
      { price: 2, stockLevel: "HIGH", brand: "Birch" },
    );
    expect(winner([a, b], ctx({ pastPickIds: new Set(["A"]), preferences: prefersBirch }))).toBe(
      "A",
    );
  });

  it("unit-price fit decides alone: A covers the line for less, B is preferred and in stock", () => {
    const [a, b] = pair(
      { price: 2, stockLevel: "LOW", brand: "Alder" },
      { price: 5, stockLevel: "HIGH", brand: "Birch" },
    );
    expect(winner([a, b], ctx({ preferences: prefersBirch }))).toBe("A");
  });

  it("unit-price fit is per needed quantity, not per package", () => {
    // 2 lb needed: A is a 2 lb pack for $7, B is 1 lb for $4 (two packs, $8).
    const [a, b] = pair({ size: "2 lb", price: 7 }, { size: "1 lb", price: 4 });
    const ranked = scoreCandidates(thighs(), [b, a], ctx());
    expect(ranked[0]?.product.id).toBe("A");
    expect(ranked[1]?.plan.units).toBe(2);
  });

  it("profile preference decides alone: same price, A is the preferred brand, B has more stock", () => {
    const [a, b] = pair(
      { price: 4, stockLevel: "LOW", brand: "Alder" },
      { price: 4, stockLevel: "HIGH", brand: "Birch" },
    );
    expect(
      winner([a, b], ctx({ preferences: { ...NO_PREFERENCES, preferredBrands: ["alder"] } })),
    ).toBe("A");
  });

  it("stock decides alone: everything equal, A is in stock and B runs low", () => {
    const [a, b] = pair({ price: 4, stockLevel: "HIGH" }, { price: 4, stockLevel: "LOW" });
    expect(winner([a, b], ctx())).toBe("A");
  });

  it("compares the tuple lexicographically", () => {
    expect(compareScores([1, 0, 0, 0, 0], [0, 1, 10, 5, 2])).toBeLessThan(0);
    expect(compareScores([0, 0, 9, 0, 0], [0, 0, 9, 0, 1])).toBeGreaterThan(0);
  });
});

describe("narrowing", () => {
  const policy = DEFAULT_RUN_POLICY;
  const base = { ...ctx(), policy, reference: null, allergies: [] as never[] };

  it("keeps the products that name the food best, and drops a head-noun mismatch", () => {
    const garlic = line("G", "Garlic", 1, "head", ONTOLOGY.garlic);
    expect(relevance(garlic, { name: "Garlic" })).toBeGreaterThan(
      relevance(garlic, { name: "Frozen Garlic Bread" }),
    );
    const prepared = prepareLine(
      garlic,
      [
        product({ id: "1", name: "Garlic", size: "3 ct" }),
        product({ id: "2", name: "Puget Pantry Frozen Garlic Bread", size: "16 oz" }),
      ],
      base,
    );
    expect(prepared.ranked.map((c) => c.product.id)).toEqual(["1"]);
    expect(prepared.excluded.irrelevant).toBe(1);
  });

  it("a qualified line takes only products that carry the qualifier, else it is flagged and left unmatched", () => {
    const penne = line("P", "Penne (gluten-free)", 16, "oz", ONTOLOGY.penne, {
      qualifiers: ["gluten-free"],
    });
    expect(searchQuery(penne)).toBe("gluten-free penne");
    const plain = product({ id: "1", name: "Mock Market Penne Rigate", size: "16 oz" });
    const missing = prepareLine(penne, [plain], base);
    expect(missing.qualifierMissing).toBe(true);
    expect(missing.flags.map((f) => f.kind)).toContain("qualifier");
    const item = proposeItem(
      "x",
      missing,
      { kind: "unmatched", by: "host", reason: "none" },
      policy,
    );
    expect(item.status).toBe("unmatched");
    expect(item.alternatives.map((a) => a.product_id)).toEqual(["1"]);

    const gf = product({ id: "2", name: "Harbor Gluten Free Penne", size: "12 oz" });
    const found = prepareLine(penne, [plain, gf], base);
    expect(found.qualifierMissing).toBe(false);
    expect(found.ranked.map((c) => c.product.id)).toEqual(["2"]);
  });

  it("drops out-of-stock products while anything else is in stock", () => {
    const prepared = prepareLine(
      thighs(),
      [
        product({
          id: "1",
          name: "Chicken Thighs",
          stockLevel: "TEMPORARILY_OUT_OF_STOCK",
          price: 1,
        }),
        product({ id: "2", name: "Chicken Thighs", price: 5 }),
      ],
      base,
    );
    expect(prepared.ranked.map((c) => c.product.id)).toEqual(["2"]);
    const allOut = prepareLine(
      thighs(),
      [product({ id: "1", name: "Chicken Thighs", stockLevel: "TEMPORARILY_OUT_OF_STOCK" })],
      base,
    );
    expect(allOut.allOutOfStock).toBe(true);
    expect(allOut.flags.map((f) => f.kind)).toContain("out_of_stock");
  });

  it("asks the model only about close calls and unclear lines", () => {
    const close = prepareLine(
      thighs(),
      [
        product({ id: "1", name: "Chicken Thighs", price: 4 }),
        product({ id: "2", name: "Chicken Thighs", price: 4.2 }),
      ],
      base,
    );
    expect(needsModel(close)).toBe(true);
    const clear = prepareLine(
      thighs(),
      [
        product({ id: "1", name: "Chicken Thighs", price: 2 }),
        product({ id: "2", name: "Chicken Thighs", price: 6 }),
      ],
      base,
    );
    expect(needsModel(clear)).toBe(false);
    const freeText = line("F", "something for tacos", 1, null, null, { needsAttention: true });
    const unclear = prepareLine(freeText, [product({ id: "1", name: "Taco Shells" })], base);
    expect(needsModel(unclear)).toBe(true);
    expect(unclear.flags.map((f) => f.kind)).toContain("needs_attention");
  });
});

describe("index resolution: the chosen product always comes from the candidate list", () => {
  async function session() {
    const mock = new MockRetailer({ seed: 1 });
    const store = await storeById(mock, MOCK_STORE_ID);
    const s = new PlanningSession({
      adapter: mock,
      store,
      policy: DEFAULT_RUN_POLICY,
      allergies: [],
      transcript: new Transcript(),
      countCall: () => {},
      scoring: () => ({ ...ctx(), reference: null }),
    });
    const broth = line("B", "Chicken broth", 4, "cup", ONTOLOGY.chickenBroth);
    await s.search(broth, "chicken broth", "host");
    return { s, broth };
  }

  it("maps the index to the adapter's own Product", async () => {
    const { s, broth } = await session();
    const state = s.lines.get(broth.id);
    const offered = state?.prepared.ranked.map((c) => c.product.id) ?? [];
    expect(offered.length).toBeGreaterThan(1);
    const result = s.choose(
      { listItemId: broth.id, candidateIndex: 1, quantity: 1, reason: "use 0099999999999" },
      "model",
    );
    expect(result.ok).toBe(true);
    const decision = state?.decision;
    expect(decision?.kind).toBe("chosen");
    const chosen =
      decision?.kind === "chosen" ? state?.prepared.ranked[decision.index]?.product.id : null;
    expect(chosen).toBe(offered[1]);
    expect(chosen).not.toBe("0099999999999");
  });

  it("rejects an index out of range, retries once, then leaves the line unmatched", async () => {
    const { s, broth } = await session();
    const first = s.choose({ listItemId: broth.id, candidateIndex: 7, quantity: 1 }, "model");
    expect(first.ok).toBe(false);
    expect(s.lines.get(broth.id)?.decision).toBeNull();
    const second = s.choose({ listItemId: broth.id, candidateIndex: -1, quantity: 1 }, "model");
    expect(second.ok).toBe(false);
    expect(s.lines.get(broth.id)?.decision).toMatchObject({
      kind: "unmatched",
      flag: { kind: "low_confidence" },
    });
  });

  it("uses code's quantity when the sizes compare, the model's only when they do not", async () => {
    const { s, broth } = await session();
    s.choose({ listItemId: broth.id, candidateIndex: 0, quantity: 9 }, "model");
    const decision = s.lines.get(broth.id)?.decision;
    expect(decision?.kind === "chosen" ? decision.units : null).toBe(1);
  });
});

describe("sizes", () => {
  it("parses retailer sizes", () => {
    expect(parsePackSize("3 lb bag")).toEqual({ qty: 3, unit: "lb" });
    expect(parsePackSize("12 ct")).toEqual({ qty: 12, unit: "each" });
    expect(parsePackSize("1/2 gal")).toEqual({ qty: 0.5, unit: "gallon" });
    expect(parsePackSize("16.9 fl oz")).toEqual({ qty: 16.9, unit: "fl_oz" });
    expect(parsePackSize("per lb")).toEqual({ qty: 1, unit: "lb" });
    expect(parsePackSize(null)).toBeNull();
  });

  it("buys whole units that cover the line", () => {
    expect(
      unitsToBuy(line("a", "Whole milk", 1, "gallon", ONTOLOGY.milk), { size: "1/2 gal" }).units,
    ).toBe(2);
    expect(unitsToBuy(line("b", "Eggs", 18, "each", ONTOLOGY.egg), { size: "12 ct" }).units).toBe(
      2,
    );
    expect(
      unitsToBuy(line("c", "Onions", 3, "each", ONTOLOGY.yellowOnion), { size: "3 lb bag" }).units,
    ).toBe(1);
    expect(
      unitsToBuy(line("d", "Garlic", 1, "head", ONTOLOGY.garlic), { size: "3 ct" }).units,
    ).toBe(1);
    // "2 (14 oz) cans" with a 28 oz can on the shelf: one can, not two.
    const tomatoes = line("e", "Diced tomatoes", 2, "can", ONTOLOGY.dicedTomatoes, {
      rawTexts: ["2 (14 oz) cans diced tomatoes"],
    });
    expect(unitsToBuy(tomatoes, { size: "28 oz" }).units).toBe(1);
    expect(unitsToBuy(tomatoes, { size: "14.5 oz" }).units).toBe(2);
    expect(unitsToBuy(line("f", "Mystery", null, null, null), { size: "1 ct" })).toEqual({
      units: 1,
      known: false,
      coverage: null,
    });
  });
});
