// @mp/agent: the shopping agent (WS09). Host-agnostic: no Node, Deno or browser API, so the WS09
// worker and the WS08 WebView host run the same code. Hosts pass the adapter, persistence
// callbacks and a model caller.
//
//   planRun / pushRun / continueCheckout   the run's phases (run.ts)
//   state machine                          state.ts (the SQL guard enforces the same table)
//   policies, allergen check, scorer       policies.ts, allergens.ts, planner.ts
//   tools and the model loop               tools.ts, loop.ts
//   ledger, review, transcript             ledger.ts, review.ts, transcript.ts
//   matchLineItems, replayRun              for evals and WS15
import type { Allergen, RunPolicy } from "@mp/core";
import { DEFAULT_RUN_POLICY } from "@mp/core";
import type { Product, RetailerAdapter, Store } from "@mp/retailers";
import { needsModel, prepareLine, SEARCH_LIMIT, searchQuery } from "./planner.ts";
import { type ListLine, NO_PREFERENCES, type ShoppingPreferences } from "./types.ts";

export const packageName = "@mp/agent";

export * from "./allergens.ts";
export * from "./ledger.ts";
export * from "./loop.ts";
export * from "./planner.ts";
export * from "./policies.ts";
export * from "./replay.ts";
export * from "./review.ts";
export * from "./run.ts";
export * from "./sizes.ts";
export * from "./state.ts";
export * from "./tools.ts";
export * from "./transcript.ts";
export * from "./types.ts";

export interface LineMatch {
  listItemId: string;
  /** Code's pick (the top of the ranking), or null when nothing fits. */
  chosen: Product | null;
  /** The ranked, narrowed candidates. */
  candidates: Product[];
  /** The planner would ask the model about this line. */
  needsModel: boolean;
}

export interface MatchOptions {
  policy?: RunPolicy;
  allergies?: readonly Allergen[];
  preferences?: ShoppingPreferences;
}

/**
 * The deterministic half of line-item conversion, for evals (WS15) and tools: one search per line,
 * narrowed and ranked exactly as a run does, without a model, a ledger or a transcript.
 */
export async function matchLineItems(
  items: readonly ListLine[],
  adapter: RetailerAdapter,
  store: Store,
  options: MatchOptions = {},
): Promise<LineMatch[]> {
  const out: LineMatch[] = [];
  for (const line of items) {
    const products = await adapter.searchProducts(searchQuery(line), store, {
      limit: SEARCH_LIMIT,
    });
    const prepared = prepareLine(line, products, {
      pinnedProductId: null,
      pastPickIds: new Set(),
      preferences: options.preferences ?? NO_PREFERENCES,
      policy: options.policy ?? DEFAULT_RUN_POLICY,
      reference: null,
      allergies: options.allergies ?? [],
    });
    out.push({
      listItemId: line.id,
      chosen: prepared.qualifierMissing ? null : (prepared.ranked[0]?.product ?? null),
      candidates: prepared.ranked.map((c) => c.product),
      needsModel: needsModel(prepared),
    });
  }
  return out;
}
