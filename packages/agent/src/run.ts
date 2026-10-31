// A run's phases, as a host drives them (docs/03-ai-design.md §8 order of operations):
//
//   planRun          searches, scores, asks the model about the close calls, applies every policy
//                    and the allergen check, and returns the proposed cart. No cart writes. The
//                    host then writes the rows and moves the run to needs_review (request_review).
//   pushRun          after approval: refuses an approved cart over the budget cap, pushes it
//                    through the ledger, and returns cart_ready with the hand-off link (finish),
//                    or needs_review again when the retailer's quota stops it.
//   continueCheckout Tier 3 only (checkout = browser): slots and pay, under the review gate and
//                    the auto_checkout cap. Kroger hands both to the person instead.
//
// Host-agnostic: the host passes the adapter, the persistence callbacks and the model caller.

import type { ReviewSummaryVars } from "@mp/llm";
import { type Product, type RetailerAdapter, RetailerQuotaError } from "@mp/retailers";
import { type AllergenVerdict, enforceAllergens } from "./allergens.ts";
import {
  type LedgerRow,
  type LedgerStore,
  type PushOutcome,
  type PushStop,
  pushCart,
} from "./ledger.ts";
import { type LoopOutcome, type ModelCaller, runModelLoop } from "./loop.ts";
import {
  type LineDecision,
  needsModel,
  type PreparedLine,
  proposeItem,
  reviewCount,
  SEARCH_LIMIT,
  searchQuery,
  subtotalOf,
} from "./planner.ts";
import {
  assertWithinBudget,
  budgetFlag,
  canAutoCheckout,
  cents,
  limitsOf,
  PolicyViolation,
  type SubstitutionReference,
} from "./policies.ts";
import { checkToolAccess, PlanningSession, ToolLimitError } from "./tools.ts";
import { Transcript, type TranscriptSink } from "./transcript.ts";
import type {
  CartSnapshot,
  ItemFlag,
  ListLine,
  ProposedItem,
  PushPayload,
  RunContext,
  RunFlag,
  RunProgress,
  RunStatus,
  ShoppingPreferences,
  TranscriptEntry,
} from "./types.ts";

export interface PlanDeps {
  adapter: RetailerAdapter;
  /** Null or absent: no model (no key, over the cost cap). Code picks and flags the close calls. */
  callModel?: ModelCaller | null;
  /** The review summary (Haiku). Absent or failing: a plain summary from the same input. */
  summarize?: ((vars: ReviewSummaryVars) => Promise<string>) | null;
  transcriptSink?: TranscriptSink;
  progress?: (progress: RunProgress) => void | Promise<void>;
  cancelled?: () => Promise<boolean>;
  now?: () => number;
  /** Ids for the proposed rows. Defaults to crypto.randomUUID. */
  newId?: () => string;
}

export interface PlanResult {
  items: ProposedItem[];
  snapshot: CartSnapshot;
  subtotalUsd: number;
  /** request_review: the run waits for the person. */
  status: "needs_review";
  push: PushPayload;
  transcript: TranscriptEntry[];
  model: LoopOutcome;
  toolCalls: number;
  /** The run was cancelled while planning; nothing should be written. */
  cancelled: boolean;
}

/** Reads the soft shopping preferences out of the members' preferences, leniently. */
export function readShoppingPreferences(raw: readonly unknown[]): ShoppingPreferences {
  const strings = (value: unknown): string[] =>
    Array.isArray(value)
      ? value
          .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
          .map((v) => v.trim().slice(0, 60))
      : [];
  const preferred = new Set<string>();
  const avoid = new Set<string>();
  let organic = false;
  for (const prefs of raw) {
    if (!prefs || typeof prefs !== "object") continue;
    const p = prefs as Record<string, unknown>;
    for (const b of strings(p.preferred_brands)) preferred.add(b);
    for (const b of strings(p.avoid_brands)) avoid.add(b);
    if (p.prefer_organic === true) organic = true;
  }
  return {
    preferredBrands: [...preferred].slice(0, 20),
    avoidBrands: [...avoid].slice(0, 20),
    preferOrganic: organic,
  };
}

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** The summary when no model writes one. Names list lines only. */
export function plainSummary(vars: ReviewSummaryVars): string {
  const ready = `${vars.matchedCount} of ${vars.itemCount} items ready, ${money(vars.subtotalUsd)} at ${vars.storeName}.`;
  if (vars.needsReview.length === 0) return `${ready} Nothing needs your call.`;
  const names = vars.needsReview.slice(0, 4).map((entry) => entry.line);
  const more =
    vars.needsReview.length > names.length
      ? `, and ${vars.needsReview.length - names.length} more`
      : "";
  const text = `${ready} ${vars.needsReview.length} need your call: ${names.join(", ")}${more}.`;
  return text.length <= 240 ? text : `${ready} ${vars.needsReview.length} need your call.`;
}

function defaultId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID(): string } }).crypto;
  if (!crypto) throw new Error("planRun needs newId where crypto.randomUUID is missing");
  return crypto.randomUUID();
}

/**
 * The planning phase. Every retailer call is a recorded tool call, quota is spent on one batch
 * lookup per 50 pinned products and one search per other line, and no cart is touched.
 */
export async function planRun(ctx: RunContext, deps: PlanDeps): Promise<PlanResult> {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? defaultId;
  const started = now();
  const limits = limitsOf(ctx.policy, started);
  const transcript = new Transcript(deps.transcriptSink ?? null, now);
  const runFlags: RunFlag[] = [];
  let toolCalls = 0;
  const countCall = () => {
    if (toolCalls >= limits.maxToolCalls) throw new ToolLimitError(limits.maxToolCalls);
    toolCalls += 1;
  };
  const report = async (done: number) => {
    await deps.progress?.({ phase: "planning", done, total: ctx.lines.length });
  };

  // Pinned and past choices for each line's ingredient.
  const pinnedByIngredient = new Map(
    ctx.choices.filter((c) => c.pinned).map((c) => [c.ingredientId, c]),
  );
  const pastByIngredient = new Map<string, Set<string>>();
  for (const choice of ctx.choices) {
    if (choice.pinned) continue;
    const set = pastByIngredient.get(choice.ingredientId) ?? new Set<string>();
    set.add(choice.productId);
    pastByIngredient.set(choice.ingredientId, set);
  }
  const pinnedProducts = new Map<string, Product>();
  const referenceFor = (line: ListLine): SubstitutionReference | null => {
    const pinned = line.ingredient ? pinnedByIngredient.get(line.ingredient.id) : undefined;
    if (!pinned) return null;
    return {
      productId: pinned.productId,
      brand: pinnedProducts.get(pinned.productId)?.brand ?? null,
    };
  };

  const session = new PlanningSession({
    adapter: deps.adapter,
    store: ctx.store,
    policy: ctx.policy,
    allergies: ctx.allergies,
    transcript,
    countCall,
    scoring: (line) => ({
      pinnedProductId: line.ingredient
        ? (pinnedByIngredient.get(line.ingredient.id)?.productId ?? null)
        : null,
      pastPickIds: line.ingredient
        ? (pastByIngredient.get(line.ingredient.id) ?? new Set())
        : new Set(),
      preferences: ctx.preferences,
      reference: referenceFor(line),
    }),
  });

  const lines = [...ctx.lines].sort((a, b) => a.position - b.position);
  const quotaLines = new Set<string>();
  let stoppedEarly: "quota" | "limit" | "cancelled" | null = null;

  try {
    // 1. Pinned products: one getProducts call per 50.
    const pinnedLines = lines.filter(
      (line) => line.ingredient && pinnedByIngredient.has(line.ingredient.id),
    );
    const pinnedIds = [
      ...new Set(
        pinnedLines.map(
          (line) => pinnedByIngredient.get(line.ingredient?.id ?? "")?.productId ?? "",
        ),
      ),
    ];
    for (let i = 0; i < pinnedIds.length; i += 50) {
      countCall();
      const batch = pinnedIds.slice(i, i + 50);
      const found = await deps.adapter.getProducts(batch, ctx.store);
      for (const product of found) pinnedProducts.set(product.id, product);
      transcript.record({
        tool: "get_product",
        by: "host",
        input: { count: batch.length },
        output_summary: `Looked up ${batch.length} pinned products: ${found.length} offered today.`,
        ok: true,
      });
    }

    let done = 0;
    for (const line of lines) {
      if (await deps.cancelled?.()) {
        stoppedEarly = "cancelled";
        break;
      }
      const pinned = line.ingredient ? pinnedByIngredient.get(line.ingredient.id) : undefined;
      const pinnedProduct = pinned ? pinnedProducts.get(pinned.productId) : undefined;
      if (pinnedProduct) {
        const state = session.addLine(line, [pinnedProduct], searchQuery(line));
        if (state.prepared.ranked.some((c) => c.product.id === pinnedProduct.id)) {
          done += 1;
          await report(done);
          continue;
        }
        // The pinned product is out of stock or unsafe today: search like any other line.
      }
      try {
        await session.search(line, searchQuery(line), "host", SEARCH_LIMIT);
      } catch (err) {
        if (err instanceof RetailerQuotaError) {
          stoppedEarly = "quota";
          for (const rest of lines.slice(lines.indexOf(line))) {
            if (!session.lines.has(rest.id)) quotaLines.add(rest.id);
          }
          runFlags.push({
            kind: "quota",
            detail: `The store's search limit for today is reached. ${quotaLines.size} lines were not searched; run again after ${new Date(err.resetsAt).toUTCString()}.`,
          });
          break;
        }
        throw err;
      }
      done += 1;
      await report(done);
    }
  } catch (err) {
    if (!(err instanceof ToolLimitError)) throw err;
    stoppedEarly = "limit";
    runFlags.push({
      kind: "limit_reached",
      detail: `The run reached its limit of ${limits.maxToolCalls} tool calls.`,
    });
  }

  // 2. Code's own decisions, and the lines for the model.
  const decideByHost = (
    state: { prepared: PreparedLine; decision: LineDecision | null },
    flag?: ItemFlag,
  ) => {
    if (state.decision) return;
    const top = state.prepared.ranked[0];
    if (!top || state.prepared.qualifierMissing) {
      state.decision = {
        kind: "unmatched",
        by: "host",
        reason: state.prepared.qualifierMissing
          ? "No product carries the line's requirement."
          : "No usable product was found.",
      };
      return;
    }
    state.decision = {
      kind: "chosen",
      index: 0,
      units: top.plan.units,
      by: "host",
      reason: null,
      lowConfidence: flag ?? null,
    };
  };

  for (const state of session.lines.values()) {
    if (state.decision) continue;
    if (state.prepared.ranked.length === 0 || state.prepared.qualifierMissing) {
      decideByHost(state);
      continue;
    }
    if (needsModel(state.prepared)) state.forModel = true;
    else decideByHost(state);
  }
  // Code's choices are tool calls too, so the transcript shows every decision.
  const recordHostDecision = (state: { prepared: PreparedLine; decision: LineDecision | null }) => {
    if (!state.decision) return;
    const input = { listItemId: state.prepared.line.id };
    transcript.record({
      tool: state.decision.kind === "chosen" ? "choose_product" : "mark_unmatched",
      by: "host",
      input:
        state.decision.kind === "chosen"
          ? { ...input, candidateIndex: state.decision.index, quantity: state.decision.units }
          : input,
      output_summary:
        state.decision.kind === "chosen"
          ? `Code chose candidate ${state.decision.index}, ${state.decision.units} units.`
          : "Code found no usable product.",
      ok: true,
    });
    toolCalls += 1;
  };
  for (const state of session.lines.values()) {
    if (!state.forModel) recordHostDecision(state);
  }

  // 3. The model, for the close calls.
  let model: LoopOutcome = {
    turns: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    stoppedBy: "none",
    error: null,
    quotaHit: false,
  };
  const modelLines = [...session.lines.values()].filter((state) => state.forModel);
  if (modelLines.length > 0 && stoppedEarly !== "cancelled") {
    if (deps.callModel && stoppedEarly !== "limit") {
      try {
        model = await runModelLoop({
          session,
          callModel: deps.callModel,
          household: {
            storeName: ctx.store.name,
            substitution: ctx.policy.substitution,
            preferredBrands: ctx.preferences.preferredBrands,
            avoidBrands: ctx.preferences.avoidBrands,
            preferOrganic: ctx.preferences.preferOrganic,
          },
          deadline: limits.deadline,
          now,
          ...(deps.cancelled ? { cancelled: deps.cancelled } : {}),
        });
      } catch (err) {
        if (!(err instanceof ToolLimitError)) throw err;
        model = { ...model, stoppedBy: "limit" };
      }
      if (model.stoppedBy === "cancelled") stoppedEarly = "cancelled";
    }
    const unavailable = !deps.callModel || model.stoppedBy === "error";
    const limited =
      model.stoppedBy === "limit" || model.stoppedBy === "deadline" || stoppedEarly === "limit";
    const open = modelLines.filter((state) => state.decision === null);
    if (open.length > 0) {
      const flag: ItemFlag = unavailable
        ? {
            kind: "model_unavailable",
            detail: "Picked the closest match without the assistant. Check it.",
          }
        : limited
          ? {
              kind: "limit_reached",
              detail:
                "The run ran out of time or steps here, so this is the closest match. Check it.",
            }
          : {
              kind: "low_confidence",
              detail: "The closest match, picked without a clear winner. Check it.",
            };
      for (const state of open) {
        decideByHost(state, flag);
        recordHostDecision(state);
      }
      if (unavailable)
        runFlags.push({
          kind: "model_unavailable",
          detail: "The assistant was unavailable, so close calls were picked by code and flagged.",
        });
      if (limited && !runFlags.some((f) => f.kind === "limit_reached")) {
        runFlags.push({
          kind: "limit_reached",
          detail: "The run reached a time or step limit before every close call was made.",
        });
      }
    }
    if (model.quotaHit && !runFlags.some((f) => f.kind === "quota")) {
      runFlags.push({
        kind: "quota",
        detail: "The store's search limit was reached while refining a search.",
      });
    }
  }

  // 4. The proposed rows, in list order, then the final allergen check on all of them.
  const products = new Map<string, Product>();
  const categories = new Map<string, string | null>();
  for (const state of session.lines.values()) {
    for (const candidate of state.prepared.ranked)
      products.set(candidate.product.id, candidate.product);
    categories.set(state.prepared.line.id, state.prepared.line.ingredient?.category ?? null);
  }
  const proposed: ProposedItem[] = [];
  for (const line of lines) {
    const state = session.lines.get(line.id);
    if (!state) {
      proposed.push({
        id: newId(),
        listItemId: line.id,
        position: line.position,
        displayName: line.displayName,
        section: line.section,
        ingredientId: line.ingredient?.id ?? null,
        product: null,
        qty: null,
        unitPriceUsd: null,
        lineTotalUsd: null,
        status: "unmatched",
        alternatives: [],
        flags: [
          quotaLines.has(line.id)
            ? { kind: "quota", detail: "Not searched: the store's daily search limit was reached." }
            : { kind: "limit_reached", detail: "Not searched: the run stopped before this line." },
        ],
        reason: null,
      });
      continue;
    }
    proposed.push(
      proposeItem(
        newId(),
        state.prepared,
        state.decision ?? { kind: "unmatched", by: "host", reason: "Not decided." },
        ctx.policy,
      ),
    );
  }
  const enforced = enforceAllergens(proposed, products, ctx.allergies, categories);
  if (enforced.removed > 0) {
    runFlags.push({
      kind: "allergen_removed",
      detail: `${enforced.removed} proposed product${enforced.removed === 1 ? "" : "s"} listed a household allergen and were removed.`,
    });
  }
  const items = enforced.items;
  const subtotalUsd = subtotalOf(items);
  const budget = budgetFlag(ctx.policy, subtotalUsd);
  if (budget) runFlags.push(budget);

  // 5. The snapshot and the review summary.
  const flagged = items.filter((item) => item.flags.length > 0);
  const summaryVars: ReviewSummaryVars = {
    storeName: ctx.store.name,
    itemCount: items.length,
    matchedCount: items.filter((item) => item.status === "matched" || item.status === "substituted")
      .length,
    subtotalUsd,
    needsReview: flagged.map((item) => ({
      line: item.displayName,
      reasons: item.flags.map((f) => f.kind),
    })),
    runNotes: runFlags.map((flag) => flag.detail),
  };
  let summary = plainSummary(summaryVars);
  if (deps.summarize && stoppedEarly !== "cancelled") {
    try {
      const written = (await deps.summarize(summaryVars)).trim();
      if (written.length > 0 && written.length <= 240) summary = written;
    } catch {
      // The plain summary stands.
    }
  }
  const snapshot: CartSnapshot = {
    version: 1,
    storeName: ctx.store.name,
    generatedAt: new Date(now()).toISOString(),
    itemCount: items.length,
    matchedCount: summaryVars.matchedCount,
    needsReviewCount: reviewCount(items),
    subtotalUsd,
    flags: runFlags,
    summary,
  };
  // request_review: the model's own call is in the transcript already when it made one.
  if (model.stoppedBy !== "review") {
    toolCalls += 1;
    transcript.record({
      tool: "request_review",
      by: "host",
      input: { count: items.length },
      output_summary: `Proposed ${summaryVars.matchedCount} of ${items.length} lines, ${money(subtotalUsd)}; ${snapshot.needsReviewCount} need review.`,
      ok: true,
    });
  }
  await transcript.flush();

  return {
    items,
    snapshot,
    subtotalUsd,
    status: "needs_review",
    push: { type: "needs_review", runId: ctx.runId, count: snapshot.needsReviewCount },
    transcript: transcript.entries(),
    model,
    toolCalls,
    cancelled: stoppedEarly === "cancelled",
  };
}

// ---------------------------------------------------------------------------------------
// Push phase
// ---------------------------------------------------------------------------------------

/** A row for the push: the ledger columns plus the approved price. */
export interface PushRow extends LedgerRow {
  unitPriceUsd: number | null;
}

export interface PushDeps {
  adapter: RetailerAdapter;
  ledger: LedgerStore;
  transcriptSink?: TranscriptSink;
  progress?: (progress: RunProgress) => void | Promise<void>;
  cancelled?: () => Promise<boolean>;
  now?: () => number;
  /** Epoch ms after which the push stops and the run is handed back for a retry. */
  deadline?: number;
}

export interface PushRunResult {
  /** cart_ready: done. needs_review: quota or budget, the person decides again. */
  status: "cart_ready" | "needs_review" | "stopped";
  stopped: PushStop | null;
  flags: RunFlag[];
  /** Flags to add to rows (unavailable, allergen, cart_rejected). */
  rowFlags: Map<string, ItemFlag[]>;
  handoffUrl: string | null;
  /** What is in the cart from this run, at the approved prices. */
  cartSubtotalUsd: number;
  push: PushPayload | null;
  outcome: PushOutcome | null;
  transcript: TranscriptEntry[];
}

export interface PushContext {
  runId: string;
  store: RunContext["store"];
  connection: RunContext["connection"];
  policy: RunContext["policy"];
  allergies: RunContext["allergies"];
  /** The subtotal the person approved. */
  approvedSubtotalUsd: number;
}

/**
 * The push phase. Refuses a cart over the budget cap before any write, pushes through the ledger,
 * and finishes with the hand-off link (Kroger: checkout = handoff). Resumable: call it again with
 * the rows as stored and it sends only what is left.
 */
export async function pushRun(
  ctx: PushContext,
  rows: readonly PushRow[],
  deps: PushDeps,
): Promise<PushRunResult> {
  const now = deps.now ?? Date.now;
  const transcript = new Transcript(deps.transcriptSink ?? null, now);
  const result: PushRunResult = {
    status: "cart_ready",
    stopped: null,
    flags: [],
    rowFlags: new Map(),
    handoffUrl: null,
    cartSubtotalUsd: 0,
    push: null,
    outcome: null,
    transcript: [],
  };

  try {
    assertWithinBudget(ctx.policy, ctx.approvedSubtotalUsd);
  } catch (err) {
    if (!(err instanceof PolicyViolation)) throw err;
    transcript.record({
      tool: "add_to_cart",
      by: "host",
      input: {},
      output_summary: "Refused: the approved cart is over the budget cap.",
      ok: false,
    });
    await transcript.flush();
    return {
      ...result,
      status: "needs_review",
      flags: [
        budgetFlag(ctx.policy, ctx.approvedSubtotalUsd) ?? { kind: "budget", detail: err.message },
      ],
      transcript: transcript.entries(),
    };
  }

  const total = rows.filter((row) => row.productId).length;
  let done = 0;
  const outcome = await pushCart({
    rows,
    adapter: deps.adapter,
    connection: ctx.connection,
    store: ctx.store,
    ledger: {
      markSent: (id, deltaSent, sentAt) => deps.ledger.markSent(id, deltaSent, sentAt),
      markResult: async (id, value) => {
        await deps.ledger.markResult(id, value);
        done += 1;
        await deps.progress?.({ phase: "pushing", done: Math.min(done, total), total });
      },
    },
    allergies: ctx.allergies,
    record: (call) => {
      transcript.record({
        tool: call.tool,
        by: "host",
        input: call.input,
        output_summary: call.summary,
        ok: call.ok,
      });
    },
    shouldStop: async () => {
      if (await deps.cancelled?.()) return "cancelled";
      if (deps.deadline !== undefined && now() >= deps.deadline) return "deadline";
      return null;
    },
    now,
  });
  result.outcome = outcome;
  for (const entry of [...outcome.skipped, ...outcome.rejected]) {
    result.rowFlags.set(entry.rowId, [...(result.rowFlags.get(entry.rowId) ?? []), entry.flag]);
  }
  if (outcome.rejected.length > 0) {
    result.flags.push({
      kind: "cart_rejected",
      detail: `${outcome.rejected.length} item${outcome.rejected.length === 1 ? "" : "s"} could not be added. Add them in the store's app.`,
    });
  }

  if (outcome.stopped === "quota") {
    result.status = "needs_review";
    result.stopped = "quota";
    result.flags.push({
      kind: "quota",
      detail: `The store's cart limit for today is reached. Approve again after ${outcome.quotaResetsAt ? new Date(outcome.quotaResetsAt).toUTCString() : "midnight UTC"} to add the rest.`,
    });
    await transcript.flush();
    return { ...result, transcript: transcript.entries() };
  }
  if (outcome.stopped) {
    result.status = "stopped";
    result.stopped = outcome.stopped;
    await transcript.flush();
    return { ...result, transcript: transcript.entries() };
  }

  // finish: the cart is filled. Kroger hands slots and pay to the person.
  const caps = deps.adapter.capabilities;
  if (caps.checkout !== "browser" && deps.adapter.handoffUrl) {
    result.handoffUrl = await deps.adapter.handoffUrl(ctx.connection, { runId: ctx.runId });
  }
  const skipped = new Set([...outcome.skipped, ...outcome.rejected].map((entry) => entry.rowId));
  result.cartSubtotalUsd = cents(
    rows
      .filter((row) => !skipped.has(row.id))
      .reduce((sum, row) => {
        const qty = Math.max(0, Math.round(row.userDecision === "removed" ? 0 : (row.qty ?? 0)));
        const going = row.status === "matched" || row.status === "substituted" ? qty : 0;
        return sum + going * (row.unitPriceUsd ?? 0);
      }, 0),
  );
  transcript.record({
    tool: "finish",
    by: "host",
    input: {},
    output_summary:
      caps.checkout === "browser"
        ? "Cart filled. Checkout continues in the browser host."
        : "Cart filled. The person pays in the store's app.",
    ok: true,
  });
  await transcript.flush();
  result.push = {
    type: "cart_ready",
    runId: ctx.runId,
    storeName: ctx.store.name,
    subtotalUsd: result.cartSubtotalUsd,
  };
  return { ...result, transcript: transcript.entries() };
}

// ---------------------------------------------------------------------------------------
// Tier 3 checkout (browser adapters, WS10)
// ---------------------------------------------------------------------------------------

export interface CheckoutDeps {
  adapter: RetailerAdapter;
  transcriptSink?: TranscriptSink;
  /** Persists a status before the step that needs it (checking_out before checkout). */
  transition: (to: RunStatus) => Promise<void>;
  /** The person tapped "Place order" in the app. */
  personApproved: boolean;
  /** Picks a window by index. Defaults to the first one with the lowest fee. */
  chooseSlot?: (slots: Awaited<ReturnType<NonNullable<RetailerAdapter["getSlots"]>>>) => number;
  now?: () => number;
}

export interface CheckoutResult {
  status: "cart_ready" | "checked_out";
  orderRef: string | null;
  /** Why checkout did not run. */
  waiting: "handoff" | "approval" | null;
  transcript: TranscriptEntry[];
}

/**
 * Slots and pay for a browser adapter, once the review gate passed and either the person tapped
 * to pay or the household's auto_checkout cap covers the cart. A hand-off store (Kroger) returns
 * at once: the person pays in the store's app.
 */
export async function continueCheckout(
  ctx: PushContext & { approved: boolean; cartSubtotalUsd: number },
  deps: CheckoutDeps,
): Promise<CheckoutResult> {
  const transcript = new Transcript(deps.transcriptSink ?? null, deps.now ?? Date.now);
  const caps = deps.adapter.capabilities;
  const state = {
    status: "cart_ready" as const,
    phase: "checkout" as const,
    approved: ctx.approved,
  };
  const access = checkToolAccess("checkout", caps, state);
  if (!access.ok) {
    transcript.record({
      tool: "checkout",
      by: "host",
      input: {},
      output_summary: access.hint,
      ok: false,
    });
    await transcript.flush();
    return {
      status: "cart_ready",
      orderRef: null,
      waiting: access.error === "needs_approval" ? "approval" : "handoff",
      transcript: transcript.entries(),
    };
  }
  const allowed =
    deps.personApproved ||
    canAutoCheckout(ctx.policy, caps, { approved: ctx.approved, subtotalUsd: ctx.cartSubtotalUsd });
  if (!allowed || !deps.adapter.getSlots || !deps.adapter.selectSlot || !deps.adapter.checkout) {
    transcript.record({
      tool: "checkout",
      by: "host",
      input: {},
      output_summary: "Waiting for the person to tap to pay.",
      ok: false,
    });
    await transcript.flush();
    return {
      status: "cart_ready",
      orderRef: null,
      waiting: "approval",
      transcript: transcript.entries(),
    };
  }
  const modality = ctx.connection.modality ?? "PICKUP";
  const slots = await deps.adapter.getSlots(ctx.connection, ctx.store, modality);
  transcript.record({
    tool: "get_slots",
    by: "host",
    input: { count: slots.length },
    output_summary: `${slots.length} windows.`,
    ok: slots.length > 0,
  });
  if (slots.length === 0) {
    await transcript.flush();
    return {
      status: "cart_ready",
      orderRef: null,
      waiting: "approval",
      transcript: transcript.entries(),
    };
  }
  const cheapest = slots.reduce(
    (best, slot, i) => ((slot.feeUsd ?? 0) < (slots[best]?.feeUsd ?? 0) ? i : best),
    0,
  );
  const index = deps.chooseSlot ? deps.chooseSlot(slots) : cheapest;
  const slot = slots[index] ?? slots[cheapest];
  if (!slot) throw new Error("no slot to select");
  await deps.adapter.selectSlot(ctx.connection, slot);
  transcript.record({
    tool: "select_slot",
    by: "host",
    input: { slotIndex: index },
    output_summary: "Window selected.",
    ok: true,
  });
  await deps.transition("checking_out");
  const { orderRef } = await deps.adapter.checkout(ctx.connection, ctx.policy);
  transcript.record({
    tool: "checkout",
    by: "host",
    input: {},
    output_summary: "Order placed.",
    ok: true,
  });
  transcript.record({
    tool: "finish",
    by: "host",
    input: {},
    output_summary: "Checked out.",
    ok: true,
  });
  await transcript.flush();
  return { status: "checked_out", orderRef, waiting: null, transcript: transcript.entries() };
}

export type { AllergenVerdict };
