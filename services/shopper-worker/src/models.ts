// The worker's models: Sonnet for the planning loop, Haiku for the review summary, both through
// @mp/llm so the per-household daily cap is checked before every call and every call writes an
// ai_runs row (kind agent_plan, then agent_step).
import {
  AGENT_REVIEW_SUMMARY_V1,
  type AiRunRecord,
  callWithTools,
  createDailyCapGuard,
  extract,
  type MessagesClient,
  MODELS,
  ReviewSummary,
  type ToolMessagesClient,
  toAiRunRow,
} from "@mp/llm";
import { errorMessage, type Logger } from "./queue.ts";
import type { ModelSource } from "./runner.ts";
import type { RunStore } from "./store.ts";

export interface ModelSourceOptions {
  toolClient: ToolMessagesClient;
  parseClient: MessagesClient;
  store: Pick<RunStore, "recordAiRun" | "spentTodayUsd" | "householdCapUsd">;
  dailyCapUsd: number;
  log: Logger;
}

export function createModelSource(options: ModelSourceOptions): ModelSource {
  const { store, log } = options;
  const sink = async (record: AiRunRecord) => {
    try {
      await store.recordAiRun(toAiRunRow(record));
    } catch (error) {
      log.warn("ai_runs insert failed", { error: errorMessage(error) });
    }
  };
  // The household's own cap (households.ai_daily_cap_usd) decides; AI_DAILY_CAP_USD is the
  // fallback. A refusal is an ai_runs row (ok false, error cost_cap) before the error is thrown.
  const guard = createDailyCapGuard({
    capUsd: options.dailyCapUsd,
    capFor: (householdId) => store.householdCapUsd(householdId),
    spentTodayUsd: (householdId) => store.spentTodayUsd(householdId),
    sink,
    onWarning: (message) => log.warn(message),
  });
  return {
    callModel: (householdId) => (request) =>
      callWithTools({ ...request, householdId }, { client: options.toolClient, log: sink, guard }),
    summarize: (householdId) => async (vars) => {
      const { value } = await extract(
        ReviewSummary,
        {
          system: AGENT_REVIEW_SUMMARY_V1.system(),
          user: AGENT_REVIEW_SUMMARY_V1.user(vars),
          model: MODELS.haiku,
          kind: AGENT_REVIEW_SUMMARY_V1.kind,
          promptVersion: AGENT_REVIEW_SUMMARY_V1.id,
          householdId,
          effort: "low",
          maxTokens: 1_000,
        },
        { client: options.parseClient, log: sink, guard },
      );
      return value.summary;
    },
  };
}
