// llm-proxy's reads and writes, over PostgREST with the service role (WS08). The caller is
// authenticated and checked for membership before any of these run, and every query names the
// household explicitly, because the service role bypasses Row Level Security.
import { type AiRunRecord, logAiRun } from "../../../packages/llm/src/log.ts";
import type { ProxyStore } from "./handler.ts";

/** The slice of a supabase-js client this store uses. */
export interface ServiceDb {
  from(table: string): {
    select(columns: string): ServiceQuery;
    insert(row: Record<string, unknown>): PromiseLike<{ error: { message: string } | null }>;
  };
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

interface ServiceQuery extends PromiseLike<QueryResult> {
  eq(column: string, value: string): ServiceQuery;
  limit(n: number): ServiceQuery;
}

interface QueryResult {
  data: Record<string, unknown>[] | null;
  error: { message: string; code?: string } | null;
}

/**
 * ai_runs has no run_id column yet (docs/02 §Ops; WS08 contract change request). Until it does,
 * rows are written without it and the run cap counts only the call in hand. Once the column
 * exists this store finds it at the first call and both write and sum by it, with no code change.
 */
export function createServiceStore(db: ServiceDb): ProxyStore {
  let runIdColumn: Promise<boolean> | null = null;
  const hasRunId = () => {
    runIdColumn ??= Promise.resolve(db.from("ai_runs").select("run_id").limit(0)).then(
      ({ error }) => error === null,
      () => false,
    );
    return runIdColumn;
  };

  return {
    async isMember(householdId, userId) {
      const { data, error } = await db
        .from("household_members")
        .select("user_id")
        .eq("household_id", householdId)
        .eq("user_id", userId)
        .limit(1);
      if (error) throw new Error(error.message);
      return (data ?? []).length > 0;
    },

    async spentSince(householdId, sinceIso) {
      const { data, error } = await db.rpc("household_ai_spend_since", {
        p_household_id: householdId,
        p_since: sinceIso,
      });
      if (error) throw new Error(error.message);
      const value = Number(data);
      return Number.isFinite(value) ? value : 0;
    },

    async runSpentUsd(householdId, runId) {
      if (!(await hasRunId())) return null;
      const { data, error } = await db
        .from("ai_runs")
        .select("cost_usd")
        .eq("household_id", householdId)
        .eq("run_id", runId);
      if (error) throw new Error(error.message);
      return (data ?? []).reduce((sum, row) => sum + Number(row.cost_usd ?? 0), 0);
    },

    async logAiRun(record: AiRunRecord, runId: string | null) {
      const withRun = runId !== null && (await hasRunId());
      await logAiRun(
        {
          insert: (row) =>
            db.from("ai_runs").insert(withRun ? { ...row, run_id: runId } : { ...row }),
        },
        record,
        (message) => console.warn(`llm-proxy: ${message}`),
      );
    },
  };
}
