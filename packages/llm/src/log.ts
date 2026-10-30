// ai_runs logging and the per-household daily cost cap (docs/03-ai-design.md §1, docs/05
// §Audit, risk R3). Every model call produces one `AiRunRecord`; the caller decides where it
// goes. The Edge Functions write it to the `ai_runs` table with the service role.

import { LlmError } from "./client.ts";

/** One model call, as recorded in `ai_runs`. */
export interface AiRunRecord {
  /** Null for system jobs. */
  householdId: string | null;
  /** extract_recipe, parse_ingredients, suggest, agent_step, embed, ... */
  kind: string;
  model: string;
  /** "<name>.v<n>" from the prompt registry. */
  promptVersion: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  latencyMs: number;
  ok: boolean;
  error: string | null;
}

/** Receives one record per model call, including failed ones. A sink must not throw. */
export type AiRunSink = (record: AiRunRecord) => void | Promise<void>;

/** The columns of public.ai_runs a record maps to (snake_case, as the table names them). */
export interface AiRunRow {
  household_id: string | null;
  kind: string;
  model: string;
  prompt_version: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  latency_ms: number;
  ok: boolean;
  error: string | null;
}

export function toAiRunRow(record: AiRunRecord): AiRunRow {
  return {
    household_id: record.householdId,
    kind: record.kind,
    model: record.model,
    prompt_version: record.promptVersion,
    input_tokens: record.inputTokens,
    output_tokens: record.outputTokens,
    cache_read_tokens: record.cacheReadTokens,
    cost_usd: record.costUsd,
    latency_ms: record.latencyMs,
    ok: record.ok,
    // Error text can echo model output; keep the row small.
    error: record.error ? record.error.slice(0, 500) : null,
  };
}

/** The slice of a supabase-js table handle that `logAiRun` needs: `db.from("ai_runs")`. */
export interface AiRunsTable {
  insert(row: AiRunRow): PromiseLike<{ error: { message: string } | null }>;
}

/**
 * Writes one `ai_runs` row. Logging must never break the feature that was paid for, so a failed
 * insert is reported to `onWarning` (default `console.warn`) and swallowed.
 */
export async function logAiRun(
  table: AiRunsTable,
  record: AiRunRecord,
  onWarning: (message: string) => void = (message) => console.warn(message),
): Promise<void> {
  try {
    const { error } = await table.insert(toAiRunRow(record));
    if (error) onWarning(`ai_runs insert failed: ${error.message}`);
  } catch (err) {
    onWarning(`ai_runs insert failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------------------

interface Price {
  /** USD per million input tokens (prompts up to 100K tokens). */
  input: number;
  /** USD per million output tokens. */
  output: number;
  /** Cache reads cost this fraction of the input price. */
  cacheReadFactor: number;
}

// docs/03-ai-design.md §1 and the Anthropic price list. docs/03 says Sonnet cache reads cost
// 0.05x; the price list says $0.20 per million for Sonnet 5.5, which is 0.1x of $2. The list wins
// because it is what the invoice uses. Cache writes are billed at 1.25x input.
const PRICES: Record<string, Price> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheReadFactor: 0.1 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheReadFactor: 0.1 },
  "claude-opus-5-5": { input: 4, output: 20, cacheReadFactor: 0.05 },
};
const CACHE_WRITE_FACTOR = 1.25;
/** Billed as Sonnet when the model is unknown, so an unlisted model never logs as free. */
const FALLBACK_PRICE: Price = PRICES["claude-sonnet-5-5"] as Price;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** USD for one call, rounded to 8 places. `inputTokens` excludes cache reads and writes. */
export function estimateCostUsd(model: string, usage: TokenUsage): number {
  const price = PRICES[model] ?? FALLBACK_PRICE;
  const cost =
    (usage.inputTokens * price.input +
      (usage.cacheReadTokens ?? 0) * price.input * price.cacheReadFactor +
      (usage.cacheWriteTokens ?? 0) * price.input * CACHE_WRITE_FACTOR +
      usage.outputTokens * price.output) /
    1_000_000;
  return Math.round(cost * 1e8) / 1e8;
}

// ---------------------------------------------------------------------------------------
// Daily cap
// ---------------------------------------------------------------------------------------

/** Called before every model call. Throws `LlmError("cost_cap")` when the call must not run. */
export interface CostGuard {
  check(householdId: string | null): Promise<void>;
}

/**
 * Caps a household's model spend per day. `spentTodayUsd` reads what the household has spent so
 * far (the Edge Functions sum today's `ai_runs.cost_usd`). System jobs (no household) are not
 * capped here. A failing spend lookup lets the call through: the cap is a cost control, not a
 * security boundary, and an outage in `ai_runs` must not take imports down.
 */
export function createDailyCapGuard(options: {
  capUsd: number;
  spentTodayUsd: (householdId: string) => Promise<number>;
  onWarning?: (message: string) => void;
}): CostGuard {
  const warn = options.onWarning ?? ((message: string) => console.warn(message));
  return {
    async check(householdId) {
      if (householdId === null) return;
      let spent: number;
      try {
        spent = await options.spentTodayUsd(householdId);
      } catch (err) {
        warn(`daily cost lookup failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      if (spent >= options.capUsd) {
        throw new LlmError(
          "cost_cap",
          `daily model budget of $${options.capUsd.toFixed(2)} reached ($${spent.toFixed(2)} spent)`,
        );
      }
    },
  };
}
