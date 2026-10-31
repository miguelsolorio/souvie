// The model loop of the planning phase (docs/03-ai-design.md §1 and §8): a manual tool-use loop
// over `messages.create`, so every tool, policy and transition stays in our code and a recorded
// run replays turn for turn with a fake model.
//
// The model gets only the lines code could not settle (planner.ts, needsModel), each with numbered
// candidates, and the planning tools. It answers with choose_product or mark_unmatched by index
// and ends with request_review. The loop stops on request_review, on a turn with no tool call
// (after one nudge), at max_tool_calls, at the wall clock, on a cancel, or on a model error. The
// planner gives whatever is still open to code, flagged for review, so a run never hangs on the
// model.
import {
  AGENT_SYSTEM_V1,
  type AgentHouseholdVars,
  householdBlock,
  LlmError,
  type MessageParam,
  type ResponseBlock,
  type SystemBlock,
  type ToolResultBlockParam,
  type ToolTurnRequest,
  type ToolTurnResult,
  type ToolUseBlock,
} from "@mp/llm";
import { RetailerQuotaError } from "@mp/retailers";
import {
  availableTools,
  checkToolAccess,
  describeLine,
  type PlanningSession,
  TOOL_INPUTS,
  TOOL_NAMES,
  ToolLimitError,
  type ToolName,
  type ToolResult,
  toolDefinitions,
} from "./tools.ts";

/** One model turn. The worker binds @mp/llm's callWithTools (guard and ai_runs logging) to it. */
export type ModelCaller = (
  request: Omit<ToolTurnRequest, "householdId">,
) => Promise<ToolTurnResult>;

export type LoopStop =
  | "review"
  | "end_turn"
  | "limit"
  | "deadline"
  | "cancelled"
  | "error"
  | "turns"
  | "none";

export interface LoopOutcome {
  turns: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  stoppedBy: LoopStop;
  error: string | null;
  /** A model search hit the retailer's quota. */
  quotaHit: boolean;
}

export interface LoopOptions {
  session: PlanningSession;
  callModel: ModelCaller;
  household: AgentHouseholdVars;
  /** Epoch ms. */
  deadline: number;
  now?: () => number;
  /** Most model turns. A 12-line run needs two or three. */
  maxTurns?: number;
  cancelled?: () => Promise<boolean>;
}

/** Output ceiling per turn: tool calls are short, and adaptive thinking at low effort is too. */
export const TURN_MAX_TOKENS = 8_000;
export const DEFAULT_MAX_TURNS = 8;

function isToolUse(block: ResponseBlock): block is ToolUseBlock {
  return block.type === "tool_use" && typeof (block as ToolUseBlock).id === "string";
}

function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

function errorResult(message: string): ToolResult {
  return {
    ok: false,
    content: JSON.stringify({ ok: false, error: "invalid", message }),
    summary: message,
  };
}

/** Runs one tool call the model asked for. Never throws, except ToolLimitError. */
async function runModelTool(
  session: PlanningSession,
  block: ToolUseBlock,
  reviewAsked: boolean,
  state: { quotaHit: boolean },
): Promise<{ result: ToolResult; review: boolean }> {
  const name = block.name;
  if (!isToolName(name)) return { result: errorResult(`There is no tool ${name}.`), review: false };
  const access = checkToolAccess(name, session.options.adapter.capabilities, {
    status: "running",
    phase: "planning",
    approved: false,
  });
  if (!access.ok) {
    return {
      result: { ok: false, content: JSON.stringify(access), summary: access.hint },
      review: false,
    };
  }

  switch (name) {
    case "search_products": {
      const input = TOOL_INPUTS.search_products.safeParse(block.input);
      if (!input.success)
        return {
          result: errorResult(
            "search_products needs listItemId and a query of 2 to 120 characters.",
          ),
          review: false,
        };
      const line = session.lines.get(input.data.listItemId);
      if (!line)
        return {
          result: errorResult(`There is no list line ${input.data.listItemId}.`),
          review: false,
        };
      try {
        const result = await session.search(
          line.prepared.line,
          input.data.query,
          "model",
          input.data.limit,
        );
        return { result, review: false };
      } catch (err) {
        if (err instanceof ToolLimitError) throw err;
        if (err instanceof RetailerQuotaError) state.quotaHit = true;
        return {
          result: errorResult("The search is unavailable now. Choose from the current list."),
          review: false,
        };
      }
    }
    case "get_product": {
      const input = TOOL_INPUTS.get_product.safeParse(block.input);
      if (!input.success)
        return {
          result: errorResult("get_product needs listItemId and candidateIndex."),
          review: false,
        };
      return {
        result: session.getProduct(input.data.listItemId, input.data.candidateIndex, "model"),
        review: false,
      };
    }
    case "choose_product": {
      const input = TOOL_INPUTS.choose_product.safeParse(block.input);
      if (!input.success)
        return {
          result: errorResult(
            "choose_product needs listItemId, an integer candidateIndex and a quantity.",
          ),
          review: false,
        };
      return { result: session.choose(input.data, "model"), review: false };
    }
    case "mark_unmatched": {
      const input = TOOL_INPUTS.mark_unmatched.safeParse(block.input);
      if (!input.success)
        return {
          result: errorResult("mark_unmatched needs listItemId and a reason."),
          review: false,
        };
      return { result: session.markUnmatched(input.data, "model"), review: false };
    }
    case "request_review": {
      const result = session.requestReview("model", reviewAsked);
      return { result, review: result.ok };
    }
    case "find_store": {
      const input = TOOL_INPUTS.find_store.safeParse(block.input);
      if (!input.success)
        return { result: errorResult("find_store needs a 5 digit zip."), review: false };
      session.options.countCall();
      const stores = await session.options.adapter.findStores(input.data.zip);
      session.options.transcript.record({
        tool: "find_store",
        by: "model",
        input: input.data,
        output_summary: `${stores.length} stores.`,
        ok: true,
      });
      return {
        result: {
          ok: true,
          content: JSON.stringify({
            ok: true,
            stores: stores.slice(0, 5).map((s) => ({ name: s.name, zip: s.zip })),
          }),
          summary: `${stores.length} stores.`,
        },
        review: false,
      };
    }
    default:
      return { result: errorResult(`${name} is not a planning tool.`), review: false };
  }
}

/**
 * Asks the model to settle the session's open model lines. Returns how it stopped; the decisions
 * are on the session's line states.
 */
export async function runModelLoop(options: LoopOptions): Promise<LoopOutcome> {
  const { session } = options;
  const now = options.now ?? Date.now;
  const outcome: LoopOutcome = {
    turns: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    stoppedBy: "none",
    error: null,
    quotaHit: false,
  };
  const open = [...session.lines.values()].filter((state) => state.forModel);
  if (open.length === 0) return outcome;

  const names = availableTools(session.options.adapter.capabilities, {
    status: "running",
    phase: "planning",
    approved: false,
  });
  const tools = toolDefinitions(names);
  const system: SystemBlock[] = [
    { type: "text", text: AGENT_SYSTEM_V1.system(), cache_control: { type: "ephemeral" } },
    { type: "text", text: householdBlock(options.household), cache_control: { type: "ephemeral" } },
  ];
  const messages: MessageParam[] = [
    { role: "user", content: AGENT_SYSTEM_V1.user({ lines: open.map(describeLine) }) },
  ];
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  let nudged = false;
  let reviewAsked = false;
  const state = { quotaHit: false };

  for (let turn = 0; turn < maxTurns; turn++) {
    if (now() >= options.deadline) {
      outcome.stoppedBy = "deadline";
      return { ...outcome, quotaHit: state.quotaHit };
    }
    if (await options.cancelled?.()) {
      outcome.stoppedBy = "cancelled";
      return { ...outcome, quotaHit: state.quotaHit };
    }

    let response: ToolTurnResult;
    try {
      response = await options.callModel({
        system,
        messages,
        tools,
        kind: turn === 0 ? "agent_plan" : "agent_step",
        promptVersion: AGENT_SYSTEM_V1.id,
        maxTokens: TURN_MAX_TOKENS,
        effort: "low",
      });
    } catch (err) {
      outcome.stoppedBy = "error";
      outcome.error =
        err instanceof LlmError ? err.code : err instanceof Error ? err.message : String(err);
      return { ...outcome, quotaHit: state.quotaHit };
    }
    outcome.turns += 1;
    outcome.costUsd += response.costUsd;
    outcome.inputTokens += response.inputTokens;
    outcome.outputTokens += response.outputTokens;
    outcome.cacheReadTokens += response.cacheReadTokens;
    messages.push({ role: "assistant", content: response.content });

    // A turn cut off by max_tokens may hold a truncated tool call: run none of it.
    if (response.stopReason === "max_tokens") {
      outcome.stoppedBy = "error";
      outcome.error = "max_tokens";
      return { ...outcome, quotaHit: state.quotaHit };
    }

    const calls = response.content.filter(isToolUse);
    if (calls.length === 0) {
      const remaining = session.undecided();
      if (remaining.length > 0 && !nudged) {
        nudged = true;
        messages.push({
          role: "user",
          content: `These lines still need choose_product or mark_unmatched: ${remaining.join(", ")}. Then call request_review.`,
        });
        continue;
      }
      outcome.stoppedBy = "end_turn";
      return { ...outcome, quotaHit: state.quotaHit };
    }

    const results: ToolResultBlockParam[] = [];
    let review = false;
    try {
      for (const call of calls) {
        const before = session.options.transcript.entries().length;
        const run = await runModelTool(session, call, reviewAsked, state);
        // A call refused before it reached a tool (unknown name, bad input, wrong phase) is still
        // a tool call: count it and put it in the transcript like the others.
        if (session.options.transcript.entries().length === before) {
          session.options.countCall();
          session.options.transcript.record({
            tool: call.name.slice(0, 40),
            by: "model",
            input: call.input,
            output_summary: run.result.summary,
            ok: false,
          });
        }
        if (call.name === "request_review") reviewAsked = true;
        review = review || run.review;
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: run.result.content,
          ...(run.result.ok ? {} : { is_error: true }),
        });
      }
    } catch (err) {
      if (err instanceof ToolLimitError) {
        outcome.stoppedBy = "limit";
        return { ...outcome, quotaHit: state.quotaHit };
      }
      throw err;
    }
    messages.push({ role: "user", content: results });
    if (review) {
      outcome.stoppedBy = "review";
      return { ...outcome, quotaHit: state.quotaHit };
    }
  }
  outcome.stoppedBy = "turns";
  return { ...outcome, quotaHit: state.quotaHit };
}
