// The golden sets `pnpm eval` runs, by the name `--suite` takes. Each is a path fragment vitest
// uses to pick eval files (docs/03-ai-design.md §10 has the thresholds).
export const SUITES = {
  /** 50 recipe URLs from recorded pages and recorded Sonnet answers (WS02). */
  import: ["packages/recipe-import/evals/import.eval.ts"],
  /** 500 ingredient lines: the grammar and lookup, then the same with recorded Haiku answers (WS03). */
  parser: ["packages/ingredient-parser/evals/"],
  /** 100 ingredient-to-product cases per retailer against MockRetailer (WS15). */
  lineItems: ["packages/agent/evals/line-items/"],
  /** Recorded shopping runs replayed against MockRetailer (WS09). */
  agentReplay: ["packages/agent/evals/agent.eval.ts"],
  /** Hard filters over ten households (WS06); the live compose and embeddings are skipped offline. */
  suggest: ["packages/llm/evals/suggest/"],
} as const satisfies Record<string, readonly string[]>;

export type SuiteName = keyof typeof SUITES;

export const SUITE_NAMES = Object.keys(SUITES) as SuiteName[];

export function isSuite(name: string): name is SuiteName {
  return Object.hasOwn(SUITES, name);
}
