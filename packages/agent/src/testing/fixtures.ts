// Test fixtures for @mp/agent: list lines shaped like WS05's grocery_list_items, with the ontology
// fields of supabase/seed/ingredients.csv, chosen to match MockRetailer's fictional catalog.
// Test-only; nothing in src imports it.
import { DEFAULT_RUN_POLICY, type RunPolicy } from "@mp/core";
import type { ConnectionHandle, Product, Store } from "@mp/retailers";
import {
  type LineIngredient,
  type ListLine,
  NO_PREFERENCES,
  type ProductChoice,
  type RunContext,
} from "../types.ts";

let ids = 0;

export function ingredient(
  name: string,
  category: string,
  defaultUnit: string,
  extra: { density?: number; unitWeight?: number } = {},
): LineIngredient {
  ids += 1;
  return {
    id: `00000000-0000-4000-8000-${String(ids).padStart(12, "0")}`,
    name,
    category,
    defaultUnit,
    densityGPerMl: extra.density ?? null,
    typicalUnitWeightG: extra.unitWeight ?? null,
  };
}

export const ONTOLOGY = {
  yellowOnion: ingredient("yellow onion", "produce", "each", { unitWeight: 150 }),
  garlic: ingredient("garlic", "produce", "clove", { unitWeight: 5 }),
  chickenThigh: ingredient("chicken thigh", "meat", "lb", { unitWeight: 115 }),
  milk: ingredient("milk", "dairy", "cup", { density: 1.03 }),
  egg: ingredient("egg", "eggs", "each", { unitWeight: 50 }),
  unsaltedButter: ingredient("unsalted butter", "dairy", "tbsp", { density: 0.96 }),
  spinach: ingredient("spinach", "produce", "cup", { density: 0.12 }),
  dicedTomatoes: ingredient("diced tomatoes", "canned", "can", { density: 1 }),
  chickenBroth: ingredient("chicken broth", "pantry", "cup", { density: 1 }),
  penne: ingredient("penne", "pantry", "oz", { density: 0.45 }),
  salmonFillet: ingredient("salmon fillet", "seafood", "lb", { unitWeight: 170 }),
  peanutButter: ingredient("peanut butter", "pantry", "tbsp", { density: 1.09 }),
  oatMilk: ingredient("oat milk", "dairy", "cup", { density: 1 }),
  shrimp: ingredient("shrimp", "seafood", "lb"),
  cheddar: ingredient("cheddar", "dairy", "cup", { density: 0.48 }),
  lemon: ingredient("lemon", "produce", "each", { unitWeight: 58 }),
  banana: ingredient("banana", "produce", "each", { unitWeight: 118 }),
} as const;

let position = 0;

export function line(
  id: string,
  displayName: string,
  qty: number | null,
  unit: string | null,
  ing: LineIngredient | null,
  extra: Partial<Pick<ListLine, "qualifiers" | "needsAttention" | "rawTexts" | "section">> = {},
): ListLine {
  position += 1;
  return {
    id,
    displayName,
    qty,
    unit,
    section: extra.section ?? ing?.category ?? "other",
    position,
    ingredient: ing,
    qualifiers: extra.qualifiers ?? [],
    needsAttention: extra.needsAttention ?? false,
    rawTexts: extra.rawTexts ?? [],
  };
}

/** A week's list: twelve lines, two of which the model has to settle and one nothing matches. */
export function twelveLines(): ListLine[] {
  position = 0;
  return [
    line("L01", "Yellow onions", 3, "each", ONTOLOGY.yellowOnion),
    line("L02", "Garlic", 1, "head", ONTOLOGY.garlic),
    line("L03", "Boneless skinless chicken thighs", 1.5, "lb", ONTOLOGY.chickenThigh),
    line("L04", "Whole milk", 1, "gallon", ONTOLOGY.milk),
    line("L05", "Large eggs", 12, "each", ONTOLOGY.egg),
    line("L06", "Unsalted butter", 8, "oz", ONTOLOGY.unsaltedButter),
    line("L07", "Baby spinach", 1, "bag", ONTOLOGY.spinach),
    line("L08", "Diced tomatoes", 2, "can", ONTOLOGY.dicedTomatoes, {
      rawTexts: ["2 (14.5 oz) cans diced tomatoes"],
    }),
    line("L09", "Chicken broth", 4, "cup", ONTOLOGY.chickenBroth),
    line("L10", "Penne (gluten-free)", 16, "oz", ONTOLOGY.penne, { qualifiers: ["gluten-free"] }),
    line("L11", "Salmon fillets", 1.5, "lb", ONTOLOGY.salmonFillet),
    line("L12", "vanilla ice cream for dessert", 1, null, null, {
      needsAttention: true,
      section: "frozen",
    }),
  ];
}

export const MOCK_STORE_ID = "MOCK0001";

export function connectionFor(
  store: Store,
  retailer: Store["retailer"] = "kroger",
): ConnectionHandle {
  return { connectionId: "conn-test", retailer, storeId: store.id, modality: "PICKUP" };
}

export function context(
  store: Store,
  lines: ListLine[],
  overrides: Partial<Omit<RunContext, "policy">> & { policy?: Partial<RunPolicy> } = {},
): RunContext {
  const { policy, ...rest } = overrides;
  return {
    runId: "run-test",
    householdId: "household-test",
    store,
    connection: connectionFor(store),
    lines,
    choices: [] as ProductChoice[],
    allergies: [],
    preferences: NO_PREFERENCES,
    ...rest,
    policy: { ...DEFAULT_RUN_POLICY, ...policy },
  };
}

/** A Product for scorer tests, with every field set. */
export function product(fields: Partial<Product> & Pick<Product, "id" | "name">): Product {
  return {
    upc: fields.upc ?? fields.id.padStart(13, "0"),
    brand: null,
    size: "1 ct",
    price: 1,
    promoPrice: null,
    soldBy: "UNIT",
    stockLevel: "HIGH",
    fulfillment: { instore: true, curbside: true, delivery: true, shiptohome: false },
    allergens: [],
    mayContain: [],
    undeclared: [],
    imageUrl: null,
    cacheUntil: "2026-10-31T23:59:59Z",
    ...fields,
  };
}
