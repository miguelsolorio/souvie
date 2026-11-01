// The AI cost dashboard's data (WS15): the three views the migration adds, read as the signed-in
// member. They are security_invoker views over ai_runs and shopping_runs, so Row Level Security
// decides the rows: a member sees their own households' numbers and nobody else's.
//
//   v_ai_cost_daily     cost and calls per household, UTC day, kind and model
//   v_ai_cost_by_prompt calls, average latency and error rate per prompt version
//   v_runs_stalled      runs still running with no heartbeat for ten minutes (no worker alive)
import { type MpClient, useHousehold, useSupabase } from "@mp/db";
import { useQuery } from "@tanstack/react-query";

export interface DailyCostRow {
  household_id: string | null;
  day: string;
  kind: string;
  model: string;
  cost_usd: number;
  calls: number;
}

export interface PromptCostRow {
  prompt_version: string | null;
  calls: number;
  avg_latency_ms: number | null;
  error_rate: number | null;
}

export interface StalledRunRow {
  run_id: string;
  household_id: string;
  retailer: string;
  status: string;
  silent_seconds: number;
}

export interface AiCosts {
  daily: DailyCostRow[];
  byPrompt: PromptCostRow[];
  stalled: StalledRunRow[];
}

/** A view is read through an untyped handle: the generated types name it only after a regen. */
interface ViewClient {
  from(view: string): {
    select(columns: string): {
      order(
        column: string,
        options: { ascending: boolean },
      ): {
        limit(
          n: number,
        ): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
      };
    };
  };
}

async function readView<T>(
  client: MpClient,
  view: string,
  columns: string,
  orderBy: string,
  ascending: boolean,
  limit: number,
): Promise<T[]> {
  const { data, error } = await (client as unknown as ViewClient)
    .from(view)
    .select(columns)
    .order(orderBy, { ascending })
    .limit(limit);
  if (error) throw new Error(`${view}: ${error.message}`);
  return (data ?? []) as T[];
}

const num = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const numOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

export async function fetchAiCosts(client: MpClient): Promise<AiCosts> {
  const [daily, byPrompt, stalled] = await Promise.all([
    readView<DailyCostRow>(
      client,
      "v_ai_cost_daily",
      "household_id, day, kind, model, cost_usd, calls",
      "day",
      false,
      200,
    ),
    readView<PromptCostRow>(
      client,
      "v_ai_cost_by_prompt",
      "prompt_version, calls, avg_latency_ms, error_rate",
      "calls",
      false,
      100,
    ),
    readView<StalledRunRow>(
      client,
      "v_runs_stalled",
      "run_id, household_id, retailer, status, silent_seconds",
      "silent_seconds",
      false,
      50,
    ),
  ]);
  return {
    // numeric columns arrive as numbers or strings; the tables want numbers.
    daily: daily.map((row) => ({ ...row, cost_usd: num(row.cost_usd), calls: num(row.calls) })),
    byPrompt: byPrompt.map((row) => ({
      ...row,
      calls: num(row.calls),
      avg_latency_ms: numOrNull(row.avg_latency_ms),
      error_rate: numOrNull(row.error_rate),
    })),
    stalled: stalled.map((row) => ({ ...row, silent_seconds: num(row.silent_seconds) })),
  };
}

export const aiCostsKey = (householdId: string | undefined) => ["ai-costs", householdId] as const;

/** The cost views for the signed-in member's households. Kept in memory only. */
export function useAiCosts() {
  const client = useSupabase();
  const household = useHousehold();
  const householdId = household.data?.id;
  return useQuery({
    queryKey: aiCostsKey(householdId),
    enabled: Boolean(householdId),
    gcTime: 0,
    queryFn: () => fetchAiCosts(client),
  });
}

// ---------------------------------------------------------------------------------------
// Formatting, pure
// ---------------------------------------------------------------------------------------

/** Dollars to four places: model calls cost fractions of a cent. */
export function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

/** 0.0833 as "8.3%". */
export function formatPercent(rate: number | null): string {
  return rate === null ? "n/a" : `${(rate * 100).toFixed(1)}%`;
}

export function formatLatency(ms: number | null): string {
  return ms === null ? "n/a" : `${Math.round(ms)} ms`;
}

/** Total cost per day, newest first, from the daily rows. */
export function totalsByDay(
  rows: readonly DailyCostRow[],
): Array<{ day: string; costUsd: number; calls: number }> {
  const byDay = new Map<string, { costUsd: number; calls: number }>();
  for (const row of rows) {
    const total = byDay.get(row.day) ?? { costUsd: 0, calls: 0 };
    total.costUsd += row.cost_usd;
    total.calls += row.calls;
    byDay.set(row.day, total);
  }
  return [...byDay]
    .map(([day, total]) => ({ day, ...total }))
    .sort((a, b) => b.day.localeCompare(a.day));
}

export function formatSilence(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
