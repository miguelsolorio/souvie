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
  store: Pick<RunStore, "recordAiRun" | "spentTodayUsd">;
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
  const guard = createDailyCapGuard({
    capUsd: options.dailyCapUsd,
    spentTodayUsd: (householdId) => store.spentTodayUsd(householdId),
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
