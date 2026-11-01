// The daily cap in front of the parser's model calls (WS15). parse-ingredients' "lines" mode has
// no household, so the cap there is per user (the WS03 review, 2026-10-30: any signed-in user
// could send 200 lines per call, again and again). A recipe's lines are capped per household.
//
// The parser calls its model through `LlmParseClient.parseBatch`, one call per 20 lines. This
// wraps that client so the guard runs before each call. A refusal reaches the parser as a failed
// batch: `onLlmError` logs it, the lines keep their grammar and lookup results, and the response
// is still 200 with whatever the deterministic path made of them. The guard writes the
// `ai_runs` row of the refusal (ok false, error 'cost_cap').
import type { LlmParseClient } from "../../../packages/ingredient-parser/src/index.ts";
import {
  type CostGuard,
  estimateInputCostUsd,
  INGREDIENT_PARSE_V1,
} from "../../../packages/llm/src/index.ts";

export interface CapSubject {
  /** Null for the "lines" mode. */
  householdId: string | null;
  /** The signed-in caller. It is what the cap counts when there is no household. */
  userId: string | null;
}

export function withCostGuard(
  llm: LlmParseClient,
  guard: CostGuard,
  subject: CapSubject,
): LlmParseClient {
  return {
    model: llm.model,
    promptVersion: llm.promptVersion,
    async parseBatch(lines) {
      await guard.check(subject.householdId, {
        kind: INGREDIENT_PARSE_V1.kind,
        model: llm.model,
        promptVersion: llm.promptVersion,
        userId: subject.userId,
        estimatedCostUsd: estimateInputCostUsd(
          llm.model,
          INGREDIENT_PARSE_V1.system().length + lines.join("\n").length,
        ),
      });
      return llm.parseBatch(lines);
    },
  };
}
