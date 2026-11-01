// Runs the line-item golden set (cases.ts) against MockRetailer through `matchLineItems`, the
// deterministic half of line-item conversion: one search per line, narrowed and ranked exactly as
// a run does, no model, no ledger. A case passes when the pick is the expected product or one of
// its accepted alternatives, or, for a case that expects nothing, when nothing is picked.
//
// The model is not part of this suite on purpose. When the top two candidates are close the
// planner asks Sonnet to choose by index among the candidates; the suite reports how often that
// happens (`needsModel`) and whether the expected product is among the candidates the model would
// see (`candidateRecall`), which is what R13 asks: the model can only pick what code offers.
import type { Allergen } from "@mp/core";
import type { Product, RetailerId, Store } from "@mp/retailers";
import { MOCK_PRODUCTS, MockRetailer } from "@mp/retailers/mock";
import { matchLineItems } from "../../src/index.ts";
import type { LineIngredient, ListLine } from "../../src/types.ts";
import { type Extra, ROWS, type Row } from "./cases.ts";

export interface Case {
  id: string;
  display: string;
  line: ListLine;
  /** Product names that count as right, the expected one first. Empty: nothing may be picked. */
  accepted: string[];
  none: boolean;
  allergies: Allergen[];
}

export interface RetailerSetup {
  id: RetailerId;
  seed: number;
  storeId: string;
}

/** Two stores of two retailers: different seeds change prices, promotions and stock. */
export const RETAILERS: readonly RetailerSetup[] = [
  { id: "kroger", seed: 1, storeId: "MOCK0001" },
  { id: "safeway", seed: 7, storeId: "MOCK0004" },
];

const VOLUME_UNITS = new Set(["tsp", "tbsp", "fl_oz", "cup", "pint", "quart", "gallon", "ml", "l"]);

function ingredientOf(index: number, row: Row): LineIngredient | null {
  const [, , unit, food, category, , extra] = row;
  if (extra?.freeText) return null;
  return {
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    name: food,
    category,
    defaultUnit: unit,
    // Volume lines need a density to meet a weight-sized pack; water-like is right for these.
    densityGPerMl: VOLUME_UNITS.has(unit) ? 1 : null,
    typicalUnitWeightG: (extra as Extra | undefined)?.weightG ?? null,
  };
}

export function buildCases(rows: readonly Row[] = ROWS): Case[] {
  return rows.map((row, index) => {
    const [display, qty, unit, , category, expect, extra] = row;
    const id = `li-${String(index + 1).padStart(3, "0")}`;
    return {
      id,
      display,
      accepted: [...expect],
      none: extra?.none === true,
      allergies: extra?.allergies ?? [],
      line: {
        id,
        displayName: display,
        qty,
        unit,
        section: category,
        position: index,
        ingredient: ingredientOf(index, row),
        qualifiers: extra?.qualifiers ?? [],
        needsAttention: extra?.freeText === true,
        rawTexts: extra?.rawTexts ?? [],
      },
    };
  });
}

export interface CaseResult {
  id: string;
  display: string;
  pass: boolean;
  expected: string[];
  /** The name of the product picked, or null. */
  picked: string | null;
  needsModel: boolean;
  /** The expected product (any accepted name) is among the candidates the model would see. */
  inCandidates: boolean;
}

export interface RetailerResult {
  retailer: RetailerId;
  results: CaseResult[];
  passed: number;
  total: number;
  /** Percent of cases that pass. */
  score: number;
  needsModel: number;
  /** Percent of picking cases whose expected product is among the candidates. */
  candidateRecall: number;
}

/** The model sees at most this many candidates (packages/agent/src/planner.ts MODEL_CANDIDATES). */
const MODEL_CANDIDATES = 8;

export async function runRetailer(
  setup: RetailerSetup,
  cases: readonly Case[],
): Promise<RetailerResult> {
  const adapter = new MockRetailer({ id: setup.id, seed: setup.seed });
  const stores = await adapter.findStores("98019");
  const store: Store | undefined = stores.find((s) => s.id === setup.storeId);
  if (!store) throw new Error(`MockRetailer has no store ${setup.storeId}`);

  const results: CaseResult[] = [];
  for (const c of cases) {
    const [match] = await matchLineItems([c.line], adapter, store, { allergies: c.allergies });
    const picked: Product | null = match?.chosen ?? null;
    const candidates = (match?.candidates ?? []).slice(0, MODEL_CANDIDATES).map((p) => p.name);
    const pass = c.none ? picked === null : picked !== null && c.accepted.includes(picked.name);
    results.push({
      id: c.id,
      display: c.display,
      pass,
      expected: c.accepted,
      picked: picked?.name ?? null,
      needsModel: match?.needsModel ?? false,
      inCandidates: c.none ? true : c.accepted.some((name) => candidates.includes(name)),
    });
  }
  const passed = results.filter((r) => r.pass).length;
  const picking = results.filter((_, i) => !cases[i]?.none);
  return {
    retailer: setup.id,
    results,
    passed,
    total: results.length,
    score: (passed / results.length) * 100,
    needsModel: results.filter((r) => r.needsModel).length,
    candidateRecall:
      picking.length === 0
        ? 100
        : (picking.filter((r) => r.inCandidates).length / picking.length) * 100,
  };
}

/** Every product name the cases accept must be one catalog product, named once. */
export function unknownProductNames(cases: readonly Case[]): string[] {
  const counts = new Map<string, number>();
  for (const product of MOCK_PRODUCTS)
    counts.set(product.name, (counts.get(product.name) ?? 0) + 1);
  return cases
    .flatMap((c) => c.accepted)
    .filter((name) => counts.get(name) !== 1)
    .sort();
}

export function formatRetailer(result: RetailerResult): string {
  const lines = [
    `Line items at ${result.retailer}: ${result.passed}/${result.total} (${result.score.toFixed(1)}%), the expected product is among the model's candidates for ${result.candidateRecall.toFixed(1)}%, ${result.needsModel} line(s) would go to the model`,
  ];
  for (const r of result.results.filter((x) => !x.pass)) {
    lines.push(
      `  FAIL ${r.id} "${r.display}": picked ${r.picked ?? "nothing"}, wanted ${r.expected.length ? r.expected.join(" | ") : "nothing"}`,
    );
  }
  return lines.join("\n");
}
