// The recorded-run scenarios (WS09): what each fixture in evals/runs/ was recorded from. The
// recorder (record.ts) runs each against MockRetailer with the real model and writes the fixture;
// the replay test runs the fixture again with the recorded model turns.
//
// Lines use the ontology's names and the mock's fictional catalog (MockRetailer fixtures), so a
// search finds real candidates and the model has real close calls to make.
import type { Allergen, RunPolicy } from "@mp/core";
import type { Capabilities } from "@mp/retailers";
import { line, ONTOLOGY, twelveLines } from "../src/testing/fixtures.ts";
import type { ListLine, ProductChoice, ShoppingPreferences } from "../src/types.ts";
import { NO_PREFERENCES } from "../src/types.ts";

export interface ReviewStep {
  listItemId: string;
  action: "keep" | "swap" | "remove" | "quantity";
  alternativeIndex?: number;
  quantity?: number;
}

export interface Scenario {
  name: string;
  description: string;
  seed: number;
  storeId: string;
  capabilities?: Partial<Capabilities>;
  policy: Partial<RunPolicy>;
  allergies: Allergen[];
  preferences: ShoppingPreferences;
  lines: () => ListLine[];
  choices: ProductChoice[];
  review: ReviewStep[];
}

const KROGER_SHAPE: Partial<Capabilities> = {
  search: "api",
  cartAdd: "api",
  cartRead: "none",
  slots: "handoff",
  checkout: "handoff",
  orders: "none",
};

let position = 0;
function reset(lines: ListLine[]): ListLine[] {
  position = 0;
  return lines.map((l) => ({ ...l, position: position++ }));
}

export const SCENARIOS: readonly Scenario[] = [
  {
    name: "weekly-12",
    description:
      "A week's twelve-line list at Mock QFC Duvall: two close calls and one free-text line for the model, a gluten-free line nothing carries, one swap and one quantity change at review.",
    seed: 1,
    storeId: "MOCK0001",
    policy: {},
    allergies: [],
    preferences: NO_PREFERENCES,
    lines: twelveLines,
    choices: [],
    review: [
      { listItemId: "L04", action: "swap", alternativeIndex: 0 },
      { listItemId: "L03", action: "quantity", quantity: 1 },
    ],
  },
  {
    name: "allergies-milk-peanut",
    description:
      "A household allergic to milk and peanuts: butter, peanut butter and cheddar are left out before the model sees them, oat milk stays, the rest is accepted.",
    seed: 1,
    storeId: "MOCK0001",
    policy: {},
    allergies: ["milk", "peanut"],
    preferences: NO_PREFERENCES,
    lines: () =>
      reset([
        line("A01", "Unsalted butter", 8, "oz", ONTOLOGY.unsaltedButter),
        line("A02", "Peanut butter", 16, "oz", ONTOLOGY.peanutButter),
        line("A03", "Shredded cheddar", 8, "oz", ONTOLOGY.cheddar),
        line("A04", "Oat milk", 8, "cup", ONTOLOGY.oatMilk),
        line("A05", "Large eggs", 12, "each", ONTOLOGY.egg),
        line("A06", "Chicken broth", 4, "cup", ONTOLOGY.chickenBroth),
        line("A07", "Lemons", 4, "each", ONTOLOGY.lemon),
        line("A08", "Bananas", 6, "each", ONTOLOGY.banana),
      ]),
    choices: [],
    review: [],
  },
  {
    name: "pinned-same-brand",
    description:
      "Pinned products: whole milk is pinned and offered, eggs are pinned to a product the store no longer carries, so a same-brand substitute is proposed. The household removes a line at review.",
    seed: 1,
    storeId: "MOCK0001",
    policy: { substitution: "same_brand" },
    allergies: [],
    preferences: { preferredBrands: ["Harbor Fields"], avoidBrands: [], preferOrganic: false },
    lines: () =>
      reset([
        line("P01", "Whole milk", 1, "gallon", ONTOLOGY.milk),
        line("P02", "Large eggs", 12, "each", ONTOLOGY.egg),
        line("P03", "Yellow onions", 3, "each", ONTOLOGY.yellowOnion),
        line("P04", "Chicken thighs", 2, "lb", ONTOLOGY.chickenThigh),
        line("P05", "Chicken broth", 4, "cup", ONTOLOGY.chickenBroth),
        line("P06", "Salmon fillets", 1, "lb", ONTOLOGY.salmonFillet),
      ]),
    choices: [
      {
        ingredientId: ONTOLOGY.milk.id,
        productId: "0099020000001",
        upc: "0099020000001",
        productName: "Northfork Creamery Whole Milk",
        size: "1 gal",
        pinned: true,
        lastChosenAt: "2026-10-24T17:00:00.000Z",
      },
      {
        ingredientId: ONTOLOGY.egg.id,
        productId: "0099029999999",
        upc: "0099029999999",
        productName: "Northfork Creamery Pasture Eggs",
        size: "12 ct",
        pinned: true,
        lastChosenAt: "2026-10-24T17:00:00.000Z",
      },
      {
        ingredientId: ONTOLOGY.chickenThigh.id,
        productId: "0099030000003",
        upc: "0099030000003",
        productName: "Harbor Fields Bone-In Chicken Thighs",
        size: "1 lb",
        pinned: false,
        lastChosenAt: "2026-10-24T17:00:00.000Z",
      },
    ],
    review: [{ listItemId: "P06", action: "remove" }],
  },
  {
    name: "budget-and-ceiling",
    description:
      "A $30 budget and an $8 per-item limit: the proposal goes to review over budget with the salmon flagged, and the household removes the salmon to approve under the cap.",
    seed: 2,
    storeId: "MOCK0001",
    policy: { budget_cap_usd: 30, per_item_ceiling_usd: 8 },
    allergies: [],
    preferences: NO_PREFERENCES,
    lines: () =>
      reset([
        line("B01", "Salmon fillets", 1.5, "lb", ONTOLOGY.salmonFillet),
        line("B02", "Whole milk", 1, "gallon", ONTOLOGY.milk),
        line("B03", "Large eggs", 12, "each", ONTOLOGY.egg),
        line("B04", "Yellow onions", 3, "each", ONTOLOGY.yellowOnion),
        line("B05", "Garlic", 1, "head", ONTOLOGY.garlic),
        line("B06", "Chicken broth", 4, "cup", ONTOLOGY.chickenBroth),
        line("B07", "Diced tomatoes", 2, "can", ONTOLOGY.dicedTomatoes, {
          rawTexts: ["2 (14.5 oz) cans diced tomatoes"],
        }),
      ]),
    choices: [],
    review: [{ listItemId: "B01", action: "remove" }],
  },
  {
    name: "kroger-shape-free-text",
    description:
      "The Kroger capability shape (no cart read, slots and pay hand off) on the mock, so the push runs on the ledger alone; three free-text lines the model has to read.",
    seed: 3,
    storeId: "MOCK0003",
    capabilities: KROGER_SHAPE,
    policy: {},
    allergies: [],
    preferences: NO_PREFERENCES,
    lines: () =>
      reset([
        line("K01", "something for tacos: tortillas", 1, null, null, {
          needsAttention: true,
          section: "pantry",
        }),
        line("K02", "a big bag of frozen fries", 1, null, null, {
          needsAttention: true,
          section: "frozen",
        }),
        line("K03", "strawberry jam for toast", 1, null, null, {
          needsAttention: true,
          section: "pantry",
        }),
        line("K04", "Large eggs", 12, "each", ONTOLOGY.egg),
        line("K05", "Whole milk", 1, "gallon", ONTOLOGY.milk),
        line("K06", "Baby spinach", 1, "bag", ONTOLOGY.spinach),
      ]),
    choices: [],
    review: [{ listItemId: "K05", action: "quantity", quantity: 2 }],
  },
];
