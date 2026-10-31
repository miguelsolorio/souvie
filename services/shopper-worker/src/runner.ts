// One queue message, one run phase (docs/03-ai-design.md §8, the brief's lifecycle walkthrough).
//
//   claim     the run row (store.claim): queued, or approved and waiting for a worker
//   plan      not approved yet: load the list, plan with @mp/agent, write the proposal, move to
//             needs_review, notify ("3 items need your call")
//   push      approved: push the cart through the ledger, move to cart_ready with the hand-off
//             link, notify ("Cart ready at QFC Duvall, $142.17. Review and pay."); quota or the
//             budget send it back to needs_review
//
// A shutdown hands the run back (queued) and the message becomes visible at once. A failed
// attempt is retried twice; the third failure dead-letters the message and fails the run with the
// error (queue.ts). A connection that needs a new sign-in fails the run at once: the agent never
// retries auth in a loop (docs/05).
import {
  type ModelCaller,
  PolicyViolation,
  type PushPayload,
  planRun,
  pushRun,
  type RunContext,
  type RunProgress,
  readShoppingPreferences,
  resolvePolicy,
} from "@mp/agent";
import type { ReviewSummaryVars } from "@mp/llm";
import { isRetailerError, RetailerAuthError } from "@mp/retailers";
import type { AdapterSource } from "./adapters.ts";
import type { Heartbeat } from "./heartbeat.ts";
import { errorMessage, type HandlerOutcome, type Logger, type QueueMessage } from "./queue.ts";
import { type ClaimedRun, connectionHandle, InvalidAllergyError, type RunStore } from "./store.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The run id in a {"run_id": "<uuid>"} message, or null for anything else. */
export function parseRunMessage(message: unknown): string | null {
  const runId = (message as { run_id?: unknown } | null)?.run_id;
  return typeof runId === "string" && UUID.test(runId) ? runId.toLowerCase() : null;
}

/** Models for one household's run. Absent: no key, so code picks the close calls. */
export interface ModelSource {
  callModel(householdId: string): ModelCaller;
  summarize(householdId: string): (vars: ReviewSummaryVars) => Promise<string>;
}

export type PushSender = (householdId: string, payload: PushPayload) => Promise<void>;

export interface RunnerOptions {
  store: RunStore;
  adapters: AdapterSource;
  models: ModelSource | null;
  notify: PushSender;
  heartbeat: Heartbeat;
  log: Logger;
  now?: () => number;
}

/** A run the worker gave up on for a reason a retry cannot fix. */
class FatalRunError extends Error {}

/** The handler stopped because the worker is shutting down. */
class HandedBack extends Error {}

export class RunRunner {
  readonly #o: RunnerOptions;
  readonly #now: () => number;

  constructor(options: RunnerOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
  }

  /** The queue handler. */
  handle = async (message: QueueMessage, signal: AbortSignal): Promise<HandlerOutcome> => {
    const { store, log, heartbeat } = this.#o;
    const runId = parseRunMessage(message.message);
    if (!runId) {
      log.warn("message without a run id, dropped", { msgId: message.msgId });
      return "done";
    }
    if (signal.aborted) return "requeued";
    const run = await store.claim(runId);
    if (!run) {
      // Done, cancelled, waiting for review, or held by another worker: nothing to do here.
      log.info("run not claimable, message acked", { runId, status: await store.status(runId) });
      return "done";
    }
    heartbeat.hold(run.id, message.msgId);
    log.info("run claimed", {
      runId,
      phase: run.approvedAt ? "push" : "plan",
      attempt: message.readCount,
    });
    try {
      if (run.approvedAt) await this.#push(run, signal);
      else await this.#plan(run, signal);
      return "done";
    } catch (error) {
      if (error instanceof HandedBack) {
        await store.requeue(run);
        log.info("run handed back", { runId });
        return "requeued";
      }
      if (
        error instanceof FatalRunError ||
        error instanceof PolicyViolation ||
        error instanceof InvalidAllergyError
      ) {
        await store.fail(run.id, error.message);
        log.warn("run failed", { runId, error: error.message });
        return "done";
      }
      if (error instanceof RetailerAuthError) {
        if (run.connectionId)
          await store.rpc("retailer_mark_needs_reauth", { p_connection_id: run.connectionId });
        await store.fail(run.id, "needs_reauth: the store connection needs a new sign-in");
        log.warn("run failed: connection needs a new sign-in", { runId });
        return "done";
      }
      // Anything else is worth a retry. queue.ts decides whether this was the last attempt.
      throw error;
    } finally {
      heartbeat.release(run.id);
    }
  };

  /** Told about every failed attempt: hand the run back, or fail it on the last one. */
  onFailure = async (message: QueueMessage, error: unknown, final: boolean): Promise<void> => {
    const runId = parseRunMessage(message.message);
    if (!runId) return;
    if (final) {
      const detail = isRetailerError(error)
        ? `${error.code}: ${error.message}`
        : errorMessage(error);
      await this.#o.store.fail(runId, `failed after ${message.readCount} attempts: ${detail}`);
      return;
    }
    await this.#o.store.requeueById(runId);
  };

  async #context(run: ClaimedRun) {
    const { store, adapters } = this.#o;
    const input = await store.loadPlanningInput(run);
    const connection = input.connection;
    if (!connection)
      throw new FatalRunError("connection_missing: the run's store connection was removed");
    if (connection.status !== "active") {
      throw new FatalRunError(
        `connection_${connection.status}: the store connection needs attention`,
      );
    }
    const adapter = adapters.get(connection.retailer);
    if (!adapter) {
      throw new FatalRunError(
        `adapter_unavailable: no ${connection.retailer} adapter in this worker`,
      );
    }
    if (adapters.mode === "live" && connection.authType === "none") {
      throw new FatalRunError("connection_unusable: this connection has no credentials");
    }
    const policy = resolvePolicy(run.policy);
    const storeRow = await adapters.storeFor(
      adapter,
      run.storeId ?? connection.storeId,
      run.storeName ?? connection.storeName,
    );
    const ctx: RunContext = {
      runId: run.id,
      householdId: run.householdId,
      store: storeRow,
      connection: connectionHandle(connection),
      policy,
      lines: input.lines,
      choices: input.choices,
      allergies: input.allergies,
      preferences: readShoppingPreferences(input.memberPreferences),
    };
    return { ctx, adapter };
  }

  #progress(run: ClaimedRun) {
    let last = 0;
    return async (progress: RunProgress) => {
      const now = this.#now();
      if (progress.done < progress.total && now - last < 1_500) return;
      last = now;
      await this.#o.store.setProgress(run, progress);
    };
  }

  #cancelled(run: ClaimedRun, signal: AbortSignal) {
    let checkedAt = 0;
    let cancelled = false;
    return async () => {
      if (signal.aborted) return true;
      const now = this.#now();
      if (now - checkedAt >= 1_000) {
        checkedAt = now;
        cancelled = (await this.#o.store.status(run.id)) === "cancelled";
      }
      return cancelled;
    };
  }

  async #plan(run: ClaimedRun, signal: AbortSignal): Promise<void> {
    const { store, models, log } = this.#o;
    const { ctx, adapter } = await this.#context(run);
    const result = await planRun(ctx, {
      adapter,
      callModel: models?.callModel(run.householdId) ?? null,
      summarize: models?.summarize(run.householdId) ?? null,
      transcriptSink: { append: (entries) => store.appendTranscript(run, entries) },
      progress: this.#progress(run),
      cancelled: this.#cancelled(run, signal),
      now: this.#now,
    });
    if (result.cancelled) {
      if (signal.aborted) throw new HandedBack("shutdown");
      log.info("run cancelled while planning", { runId: run.id });
      return;
    }
    const written = await store.writeProposal(run, result);
    if (!written) {
      log.info("run left running before the proposal was written", { runId: run.id });
      return;
    }
    log.info("proposal ready", {
      runId: run.id,
      items: result.items.length,
      needsReview: result.snapshot.needsReviewCount,
      modelTurns: result.model.turns,
      modelCostUsd: result.model.costUsd,
      toolCalls: result.toolCalls,
    });
    await this.#notify(run.householdId, result.push);
  }

  async #push(run: ClaimedRun, signal: AbortSignal): Promise<void> {
    const { store, log } = this.#o;
    const { ctx, adapter } = await this.#context(run);
    const rows = await store.loadPushRows(run);
    const deadline = this.#now() + ctx.policy.max_wall_clock_seconds * 1000;
    const result = await pushRun(
      {
        runId: run.id,
        store: ctx.store,
        connection: ctx.connection,
        policy: ctx.policy,
        allergies: ctx.allergies,
        approvedSubtotalUsd: run.subtotalUsd ?? 0,
      },
      rows,
      {
        adapter,
        ledger: store.ledger(run),
        transcriptSink: { append: (entries) => store.appendTranscript(run, entries) },
        progress: this.#progress(run),
        cancelled: this.#cancelled(run, signal),
        now: this.#now,
        deadline,
      },
    );
    if (result.status === "stopped") {
      if (result.stopped === "cancelled" && !signal.aborted) {
        log.info("run cancelled while pushing", { runId: run.id });
        return;
      }
      // Shutdown or the clock: hand back, and the next attempt resumes from the ledger.
      throw new HandedBack(result.stopped ?? "stopped");
    }
    const finished = await store.finishPush(run, {
      status: result.status,
      flags: result.flags,
      rowFlags: result.rowFlags,
      handoffUrl: result.handoffUrl,
      cartSubtotalUsd: result.cartSubtotalUsd,
    });
    if (!finished) return;
    log.info(result.status === "cart_ready" ? "cart ready" : "push paused for review", {
      runId: run.id,
      sent: result.outcome?.sent ?? 0,
      rejected: result.outcome?.rejected.length ?? 0,
      skipped: result.outcome?.skipped.length ?? 0,
    });
    if (result.status === "cart_ready" && result.push) {
      await this.#notify(run.householdId, result.push);
    } else if (result.status === "needs_review") {
      await this.#notify(run.householdId, {
        type: "needs_review",
        runId: run.id,
        count: result.rowFlags.size,
      });
    }
  }

  async #notify(householdId: string, payload: PushPayload): Promise<void> {
    try {
      await this.#o.notify(householdId, payload);
    } catch (error) {
      this.#o.log.warn("push notification failed", {
        type: payload.type,
        error: errorMessage(error),
      });
    }
  }
}
