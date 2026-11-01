import { MockRetailer } from "@mp/retailers/mock";
import { describe, expect, it } from "vitest";
import { allergenOfLabel, allergensInName, checkProduct, enforceAllergens } from "./allergens.ts";
import type { ModelCaller } from "./loop.ts";
import { storeById } from "./replay.ts";
import { planRun } from "./run.ts";
import { context, line, MOCK_STORE_ID, ONTOLOGY, product } from "./testing/fixtures.ts";
import type { ProposedItem } from "./types.ts";

describe("allergen labels", () => {
  it("maps retailer labels to the household vocabulary, strictly", () => {
    expect(allergenOfLabel("Milk")).toBe("milk");
    expect(allergenOfLabel("Tree Nuts")).toBe("tree_nut");
    expect(allergenOfLabel("Crustacean Shellfish")).toBe("shellfish");
    expect(allergenOfLabel("Peanuts")).toBe("peanut");
    expect(allergenOfLabel("Wheat")).toBe("wheat");
    expect(allergenOfLabel("Gluten")).toBe("wheat");
    expect(allergenOfLabel("Eggs")).toBe("egg");
    expect(allergenOfLabel("Sesame Seeds")).toBe("sesame");
    expect(allergenOfLabel("Lupin")).toBeNull();
  });

  it("reads names only to raise a flag, with the plant-milk and nut-butter exceptions", () => {
    expect(allergensInName("Larkspur Kitchen Creamy Peanut Butter")).toEqual(["peanut"]);
    expect(allergensInName("Northfork Creamery Oat Milk")).toEqual([]);
    expect(allergensInName("Mock Market Salted Butter")).toEqual(["milk"]);
    expect(allergensInName("Puget Pantry Corn Tortillas")).toEqual([]);
    expect(allergensInName("Mock Market Flour Tortillas")).toEqual(["wheat"]);
  });
});

describe("checkProduct", () => {
  const butter = product({ id: "b", name: "Mock Market Salted Butter", allergens: ["Milk"] });

  it("blocks a product that contains a household allergen", () => {
    const verdict = checkProduct(butter, ["milk"]);
    expect(verdict.blocked).toEqual(["milk"]);
    expect(verdict.flags.map((f) => f.kind)).toEqual(["allergen"]);
  });

  it("blocks nothing and flags nothing with no household allergies", () => {
    expect(checkProduct(butter, [])).toEqual({ blocked: [], flags: [] });
  });

  it("flags may-contain and undeclared for review instead of blocking", () => {
    const bar = product({
      id: "c",
      name: "Trail Bar",
      allergens: ["Tree Nuts", "Peanuts"],
      mayContain: ["Tree Nuts"],
      undeclared: ["Peanuts"],
    });
    const verdict = checkProduct(bar, ["tree_nut", "peanut"]);
    expect(verdict.blocked).toEqual([]);
    expect(verdict.flags.map((f) => f.kind)).toEqual(["allergen_may_contain"]);
  });

  it("flags a label it cannot read", () => {
    const odd = product({ id: "d", name: "Lupin Flour Crackers", allergens: ["Lupin"] });
    expect(checkProduct(odd, ["peanut"]).flags.map((f) => f.kind)).toContain("allergen_unknown");
  });

  it("flags missing allergen data when the name or the ingredient's category points at an allergen", () => {
    const noData = product({ id: "e", name: "Store Brand Cheddar", allergens: [] });
    expect(checkProduct(noData, ["milk"]).flags.map((f) => f.kind)).toEqual([
      "allergen_data_missing",
    ]);
    const plain = product({ id: "f", name: "Harbor Fields Thing", allergens: [] });
    expect(
      checkProduct(plain, ["milk"], { ingredientCategory: "dairy" }).flags.map((f) => f.kind),
    ).toEqual(["allergen_data_missing"]);
    expect(checkProduct(plain, ["milk"], { ingredientCategory: "produce" }).flags).toEqual([]);
    const oat = product({ id: "g", name: "Northfork Creamery Oat Milk", allergens: [] });
    expect(checkProduct(oat, ["milk"], { ingredientCategory: "dairy" }).flags).toEqual([]);
  });
});

describe("the final check on the proposed cart", () => {
  function item(fields: Partial<ProposedItem>): ProposedItem {
    return {
      id: "row-1",
      listItemId: "L1",
      position: 1,
      displayName: "Peanut butter",
      section: "pantry",
      ingredientId: null,
      product: {
        productId: "0099040000033",
        upc: "0099040000033",
        name: "Larkspur Kitchen Creamy Peanut Butter",
        brand: "Larkspur Kitchen",
        size: "16 oz",
        price: 2.99,
      },
      qty: 1,
      unitPriceUsd: 2.99,
      lineTotalUsd: 2.99,
      status: "matched",
      alternatives: [],
      flags: [],
      reason: "The model says this one is peanut-safe.",
      ...fields,
    };
  }
  const peanutButter = product({
    id: "0099040000033",
    name: "Larkspur Kitchen Creamy Peanut Butter",
    allergens: ["Peanuts"],
  });
  const sunflower = product({ id: "0099040000099", name: "Sunflower Seed Butter", allergens: [] });

  it("removes and flags a product with a household allergen, whatever the model said", () => {
    const products = new Map([
      [peanutButter.id, peanutButter],
      [sunflower.id, sunflower],
    ]);
    const proposed = item({
      alternatives: [
        {
          product_id: sunflower.id,
          upc: sunflower.upc,
          name: sunflower.name,
          size: "16 oz",
          price: 4.99,
          qty: 1,
        },
        {
          product_id: peanutButter.id,
          upc: peanutButter.upc,
          name: peanutButter.name,
          size: "16 oz",
          price: 2.99,
          qty: 1,
        },
      ],
    });
    const { items, removed } = enforceAllergens([proposed], products, ["peanut"]);
    expect(removed).toBe(1);
    const [out] = items;
    expect(out?.status).toBe("removed");
    expect(out?.product).toBeNull();
    expect(out?.lineTotalUsd).toBeNull();
    expect(out?.flags.map((f) => f.kind)).toEqual(["allergen"]);
    expect(out?.alternatives.map((a) => a.product_id)).toEqual([sunflower.id]);
  });

  it("removes a product it cannot verify", () => {
    const { items } = enforceAllergens([item({})], new Map(), ["peanut"]);
    expect(items[0]?.status).toBe("removed");
  });

  it("keeps a safe product untouched", () => {
    const products = new Map([[peanutButter.id, peanutButter]]);
    const { items, removed } = enforceAllergens([item({})], products, ["milk"]);
    expect(removed).toBe(0);
    expect(items[0]?.status).toBe("matched");
  });
});

describe("allergens in a planned run", () => {
  it("never offers the model a product with a household allergen, and flags the line before review", async () => {
    const mock = new MockRetailer({ seed: 1 });
    const store = await storeById(mock, MOCK_STORE_ID);
    const lines = [
      line("A1", "Unsalted butter", 8, "oz", ONTOLOGY.unsaltedButter),
      line("A2", "Peanut butter", 16, "oz", ONTOLOGY.peanutButter),
      line("A3", "Shredded cheddar", 8, "oz", ONTOLOGY.cheddar),
      line("A4", "Oat milk", 8, "cup", ONTOLOGY.oatMilk),
    ];
    const seen: string[] = [];
    const callModel: ModelCaller = async (request) => {
      seen.push(JSON.stringify(request.messages));
      return {
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        model: "m",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
      };
    };
    const result = await planRun(context(store, lines, { allergies: ["milk", "peanut"] }), {
      adapter: mock,
      callModel,
    });
    const byLine = new Map(result.items.map((i) => [i.listItemId, i]));
    for (const id of ["A1", "A2", "A3"]) {
      expect(byLine.get(id)?.product, id).toBeNull();
      expect(
        byLine.get(id)?.flags.map((f) => f.kind),
        id,
      ).toContain("allergen");
    }
    expect(byLine.get("A4")?.product?.name).toBe("Northfork Creamery Oat Milk");
    for (const message of seen) {
      expect(message).not.toMatch(/Unsalted Butter|Peanut Butter|Cheddar/);
    }
    expect(mock.calls.some((c) => c.operation === "addToCart")).toBe(false);
  });

  it("removes at the last layer a product whose allergen data arrived after the line was scored", async () => {
    const mock = new MockRetailer({ seed: 1 });
    const store = await storeById(mock, MOCK_STORE_ID);
    const lines = [line("L1", "Chicken broth", 4, "cup", ONTOLOGY.chickenBroth)];
    // Every broth looks clean while the line is scored. Its allergen data lands only afterwards,
    // so only the final check before the proposal can catch it.
    let revealed = false;
    const search = mock.searchProducts.bind(mock);
    mock.searchProducts = (async (...args: Parameters<typeof search>) =>
      (await search(...args)).map((found) =>
        Object.defineProperty({ ...found }, "allergens", {
          enumerable: true,
          get: () => (revealed ? ["Wheat"] : []),
        }),
      )) as typeof mock.searchProducts;
    const result = await planRun(context(store, lines, { allergies: ["wheat"] }), {
      adapter: mock,
      callModel: null,
      progress: async (progress) => {
        if (progress.phase === "planning" && progress.done === lines.length) revealed = true;
      },
    });
    expect(revealed).toBe(true);
    const broth = result.items[0];
    expect(broth?.product).toBeNull();
    expect(broth?.flags.map((f) => f.kind)).toContain("allergen");
    expect(result.snapshot.flags?.map((f) => f.kind)).toContain("allergen_removed");
  });
});
