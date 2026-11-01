// ai_runs logging and the daily cost cap (docs/03-ai-design.md §1, docs/05 §Audit, risk R3).
// Every model call produces one `AiRunRecord`; the caller decides where it goes. The Edge
// Functions write it to the `ai_runs` table with the service role.
//
// The cap (WS15): a household has its own `households.ai_daily_cap_usd` (default 2.00) and the
// guard falls back to AI_DAILY_CAP_USD when it cannot read it. A call with no household is capped
// per user. Before any request goes out the guard compares today's spend plus the call's
// estimated input cost with the cap. A refusal writes an `ai_runs` row (ok false, error
// 'cost_cap') and then throws `LlmError("cost_cap")`, so the dashboard counts what the cap stopped.

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
  /** The shopping run the call belongs to, when any (ai_runs.run_id, 2026-10-31). Omit outside a run. */
  runId?: string | null;
  /** The signed-in user behind a household-less call (ai_runs.user_id, WS15). Omit when unknown. */
  userId?: string | null;
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
  run_id?: string | null;
  user_id?: string | null;
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
    // Only when the caller set it, so a database without the column is never sent the key.
    ...(record.runId !== undefined ? { run_id: record.runId } : {}),
    // Same for user_id (WS15), so a database that predates the column is never sent the key.
    ...(record.userId !== undefined ? { user_id: record.userId } : {}),
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

/** What a guard is told about the call it is checking, so a refusal can be recorded as a row. */
export interface CostCall {
  /** ai_runs.kind. */
  kind: string;
  /** ai_runs.model. */
  model: string;
  promptVersion?: string | null;
  runId?: string | null;
  /** The signed-in user. A call with no household is capped per user when this is set. */
  userId?: string | null;
  /**
   * What the call will cost at least, in USD: its input at the model's price. Added to today's
   * spend before the comparison, so a call that would cross the cap is refused instead of paid.
   */
  estimatedCostUsd?: number;
}

/** Called before every model call. Throws `LlmError("cost_cap")` when the call must not run. */
export interface CostGuard {
  check(householdId: string | null, call?: CostCall): Promise<void>;
}

/** The refusal `createDailyCapGuard` throws. Still an `LlmError` with code "cost_cap". */
export class CostCapError extends LlmError {
  readonly scope: "household" | "user";
  readonly capUsd: number;
  readonly spentUsd: number;
  constructor(scope: "household" | "user", capUsd: number, spentUsd: number) {
    super(
      "cost_cap",
      `daily model budget of $${capUsd.toFixed(2)} reached ($${spentUsd.toFixed(2)} spent)`,
    );
    this.name = "CostCapError";
    this.scope = scope;
    this.capUsd = capUsd;
    this.spentUsd = spentUsd;
  }
}

/** About four characters a token: close enough to refuse early, and never a network call. */
export const CHARS_PER_TOKEN = 4;

/** USD for the input of a request of `chars` characters on `model`, from the price table. */
export function estimateInputCostUsd(model: string, chars: number): number {
  return estimateCostUsd(model, {
    inputTokens: Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN),
    outputTokens: 0,
  });
}

export interface DailyCapOptions {
  /**
   * The cap when the household has none of its own (AI_DAILY_CAP_USD, default 2), and the cap
   * for a user's household-less calls unless `userCapUsd` says otherwise.
   */
  capUsd: number;
  /**
   * The household's own cap (`households.ai_daily_cap_usd`). Null or undefined falls back to
   * `capUsd`; a failing lookup does too, with a warning.
   */
  capFor?: (householdId: string) => Promise<number | null | undefined>;
  /** What the household has spent today (UTC): the sum of today's `ai_runs.cost_usd`. */
  spentTodayUsd: (householdId: string) => Promise<number>;
  /** What a user has spent today on calls with no household (`user_ai_spend_since`). */
  userSpentTodayUsd?: (userId: string) => Promise<number>;
  userCapUsd?: number;
  /** Receives the `ai_runs` row of a refusal (ok false, error 'cost_cap'). Must not throw. */
  sink?: AiRunSink;
  onWarning?: (message: string) => void;
}

/**
 * Caps model spend per day: per household, and per user for calls that carry no household. System
 * jobs (no household, no user) are not capped here. A failing spend lookup lets the call through:
 * the cap is a cost control, not a security boundary, and an outage in `ai_runs` must not take
 * imports down. A refusal is written to `sink` (when the caller says what the call was) before
 * `LlmError("cost_cap")` is thrown.
 */
export function createDailyCapGuard(options: DailyCapOptions): CostGuard {
  const warn = options.onWarning ?? ((message: string) => console.warn(message));
  const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

  async function resolveCap(householdId: string): Promise<number> {
    let cap: number | null | undefined;
    try {
      cap = await options.capFor?.(householdId);
    } catch (err) {
      warn(`household cap lookup failed: ${describe(err)}`);
      return options.capUsd;
    }
    const value = cap === null || cap === undefined ? Number.NaN : Number(cap);
    return Number.isFinite(value) && value >= 0 ? value : options.capUsd;
  }

  return {
    async check(householdId, call) {
      let scope: "household" | "user";
      let cap: number;
      let spent: number;
      try {
        if (householdId !== null) {
          scope = "household";
          cap = await resolveCap(householdId);
          spent = Number(await options.spentTodayUsd(householdId));
        } else if (call?.userId && options.userSpentTodayUsd) {
          scope = "user";
          cap = options.userCapUsd ?? options.capUsd;
          spent = Number(await options.userSpentTodayUsd(call.userId));
        } else {
          return;
        }
      } catch (err) {
        warn(`daily cost lookup failed: ${describe(err)}`);
        return;
      }
      if (!Number.isFinite(spent)) return;
      if (spent + Math.max(0, call?.estimatedCostUsd ?? 0) < cap) return;

      if (call && options.sink) {
        try {
          await options.sink({
            householdId,
            kind: call.kind,
            model: call.model,
            promptVersion: call.promptVersion ?? null,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            costUsd: 0,
            latencyMs: 0,
            ok: false,
            error: "cost_cap",
            ...(call.runId !== undefined ? { runId: call.runId } : {}),
            ...(call.userId !== undefined ? { userId: call.userId } : {}),
          });
        } catch (err) {
          warn(`ai_runs refusal row failed: ${describe(err)}`);
        }
      }
      throw new CostCapError(scope, cap, spent);
    },
  };
}
