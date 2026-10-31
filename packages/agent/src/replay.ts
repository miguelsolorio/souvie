// Recorded runs, replayed (docs/03-ai-design.md §10; brief: replay tests and `replayRun`).
//
// A fixture is a whole run: the household's lines and choices, the policy, the model's recorded
// turns, the person's review decisions, and what came out (the proposal, the ledger, the cart).
// Replaying runs the real planner, tools, policies, review and ledger against MockRetailer, with a
// model that answers each turn from the recording. Any change in what code sends the model, how
// it maps an index, or how the cart is pushed shows up as a different outcome.
import type { Allergen, RunPolicy } from "@mp/core";
import { estimateCostUsd, type ResponseBlock, type ToolTurnResult } from "@mp/llm";
import type { Capabilities, ConnectionHandle, RetailerAdapter, Store } from "@mp/retailers";
import type { LedgerStore } from "./ledger.ts";
import type { ModelCaller } from "./loop.ts";
import { resolvePolicy } from "./policies.ts";
import { applyReview, type ReviewableItem, type ReviewDecision } from "./review.ts";
import { type PushRow, planRun, pushRun } from "./run.ts";
import type {
  ListLine,
  ProductChoice,
  ProposedItem,
  RunContext,
  RunStatus,
  ShoppingPreferences,
} from "./types.ts";

export interface RecordedTurn {
  content: ResponseBlock[];
  stop_reason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
}

export interface PlannedSummary {
  listItemId: string;
  status: ProposedItem["status"];
  productId: string | null;
  qty: number | null;
  flags: string[];
}

export interface LedgerSummary {
  listItemId: string;
  cartQty: number;
  deltaResult: string | null;
}

export interface RunFixture {
  name: string;
  description: string;
  model: string;
  /** The mock's seed, and capability overrides to stand in for another retailer's shape. */
  adapter: { seed: number; capabilities?: Partial<Capabilities> };
  context: {
    runId: string;
    householdId: string;
    storeId: string;
    policy: Partial<RunPolicy>;
    allergies: Allergen[];
    preferences: ShoppingPreferences;
    lines: ListLine[];
    choices: ProductChoice[];
  };
  turns: RecordedTurn[];
  review: { decisions: Array<Omit<ReviewDecision, "runItemId"> & { listItemId: string }> };
  expected: {
    planned: PlannedSummary[];
    toolCalls: number;
    finalStatus: RunStatus;
    ledger: LedgerSummary[];
    cart: { productId: string; quantity: number }[];
  };
  recorded?: { at: string; note: string };
}

export interface ReplayResult {
  planned: PlannedSummary[];
  toolCalls: number;
  modelCalls: number;
  costUsd: number;
  finalStatus: RunStatus;
  ledger: LedgerSummary[];
  cart: { productId: string; quantity: number }[];
  /** True when the planner asked for more turns than were recorded. */
  ranOut: boolean;
}

/** A model that answers from a recording, turn by turn. */
export function replayModel(turns: readonly RecordedTurn[], model = "claude-sonnet-5-5") {
  let next = 0;
  let ranOut = false;
  const call: ModelCaller = async () => {
    const turn = turns[next];
    next += 1;
    if (!turn) {
      ranOut = true;
      return {
        content: [{ type: "text", text: "(no more recorded turns)" }],
        stopReason: "end_turn",
        model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
      } satisfies ToolTurnResult;
    }
    const usage = {
      inputTokens: turn.usage.input_tokens,
      outputTokens: turn.usage.output_tokens,
      cacheReadTokens: turn.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: turn.usage.cache_creation_input_tokens ?? 0,
    };
    return {
      content: turn.content,
      stopReason: turn.stop_reason,
      model,
      ...usage,
      costUsd: estimateCostUsd(model, usage),
    };
  };
  return {
    call,
    calls: () => next,
    ranOut: () => ranOut,
  };
}

/** The same adapter with other capabilities, for example Kroger's shape (no cart read) on the mock. */
export function withCapabilities(
  adapter: RetailerAdapter,
  overrides: Partial<Capabilities>,
): RetailerAdapter {
  const capabilities = Object.freeze({ ...adapter.capabilities, ...overrides });
  const bound: RetailerAdapter = {
    id: adapter.id,
    capabilities,
    connect: (ctx) => adapter.connect(ctx),
    findStores: (zip, opts) => adapter.findStores(zip, opts),
    searchProducts: (q, store, opts) => adapter.searchProducts(q, store, opts),
    getProducts: (ids, store) => adapter.getProducts(ids, store),
    addToCart: (conn, items) => adapter.addToCart(conn, items),
  };
  if (capabilities.cartRead !== "none" && adapter.getCart)
    bound.getCart = (conn) => adapter.getCart?.(conn) as never;
  if (adapter.handoffUrl)
    bound.handoffUrl = (conn, run) => adapter.handoffUrl?.(conn, run) as never;
  if (capabilities.slots !== "none" && capabilities.slots !== "handoff") {
    if (adapter.getSlots) bound.getSlots = (c, s, m) => adapter.getSlots?.(c, s, m) as never;
    if (adapter.selectSlot) bound.selectSlot = (c, s) => adapter.selectSlot?.(c, s) as never;
  }
  if (capabilities.checkout === "browser" && adapter.checkout) {
    bound.checkout = (c, p) => adapter.checkout?.(c, p) as never;
  }
  return bound;
}

/** A store the mock knows, by id. */
export async function storeById(adapter: RetailerAdapter, storeId: string): Promise<Store> {
  const stores = await adapter.findStores("98019");
  const store = stores.find((s) => s.id === storeId);
  if (!store) throw new Error(`store ${storeId} is not offered by ${adapter.id}`);
  return store;
}

/** An in-memory ledger over review rows, for replays and tests. */
export function memoryLedger(rows: PushRow[]): LedgerStore {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return {
    async markSent(id, deltaSent, sentAt) {
      const row = byId.get(id);
      if (!row) throw new Error(`no row ${id}`);
      row.deltaSent = deltaSent;
      row.sentAt = sentAt;
      row.deltaResult = null;
    },
    async markResult(id, result) {
      const row = byId.get(id);
      if (!row) throw new Error(`no row ${id}`);
      row.cartQty = result.cartQty;
      row.deltaSent = result.deltaSent;
      row.deltaResult = result.deltaResult;
    },
  };
}

export function toReviewable(item: ProposedItem): ReviewableItem {
  return {
    id: item.id,
    status: item.status,
    productId: item.product?.productId ?? null,
    upc: item.product?.upc ?? null,
    productName: item.product?.name ?? null,
    size: item.product?.size ?? null,
    qty: item.qty,
    unitPriceUsd: item.unitPriceUsd,
    lineTotalUsd: item.lineTotalUsd,
    alternatives: item.alternatives,
    userDecision: null,
  };
}

export function toPushRow(
  item: ReviewableItem,
  proposed: ProposedItem,
  category: string | null,
): PushRow {
  return {
    id: item.id,
    position: proposed.position,
    displayName: proposed.displayName,
    productId: item.productId,
    upc: item.upc,
    qty: item.qty,
    status: item.status,
    userDecision: item.userDecision,
    cartQty: 0,
    deltaSent: null,
    deltaResult: null,
    sentAt: null,
    ingredientCategory: category,
    unitPriceUsd: item.unitPriceUsd,
  };
}

export function summarizePlanned(items: readonly ProposedItem[]): PlannedSummary[] {
  return items.map((item) => ({
    listItemId: item.listItemId,
    status: item.status,
    productId: item.product?.productId ?? null,
    qty: item.qty,
    flags: item.flags.map((f) => f.kind).sort(),
  }));
}

/**
 * Replays a recorded run against `adapter` (a MockRetailer built with the fixture's seed). Plans
 * with the recorded model, applies the recorded review, pushes, and reports what happened.
 */
export async function replayRun(
  fixture: RunFixture,
  adapter: RetailerAdapter,
  /** Record mode: a live model in place of the recorded turns (evals/record.ts). */
  options: { callModel?: ModelCaller } = {},
): Promise<ReplayResult> {
  const target = fixture.adapter.capabilities
    ? withCapabilities(adapter, fixture.adapter.capabilities)
    : adapter;
  const store = await storeById(target, fixture.context.storeId);
  const connection: ConnectionHandle = {
    connectionId: `replay-${fixture.context.runId}`,
    retailer: target.id,
    storeId: store.id,
    modality: "PICKUP",
  };
  const policy = resolvePolicy(fixture.context.policy);
  const ctx: RunContext = {
    runId: fixture.context.runId,
    householdId: fixture.context.householdId,
    store,
    connection,
    policy,
    lines: fixture.context.lines,
    choices: fixture.context.choices,
    allergies: fixture.context.allergies,
    preferences: fixture.context.preferences,
  };
  let clock = Date.parse("2026-10-31T16:00:00Z");
  const now = () => {
    clock += 1000;
    return clock;
  };
  let n = 0;
  const model = replayModel(fixture.turns, fixture.model);
  const plan = await planRun(ctx, {
    adapter: target,
    callModel: options.callModel ?? (fixture.turns.length > 0 ? model.call : null),
    now,
    newId: () => `item-${String(++n).padStart(2, "0")}`,
  });

  const byLine = new Map(plan.items.map((item) => [item.listItemId, item]));
  const decisions: ReviewDecision[] = fixture.review.decisions.map((d) => {
    const item = byLine.get(d.listItemId);
    return { ...d, runItemId: item?.id ?? `missing-${d.listItemId}` };
  });
  const review = applyReview(plan.items.map(toReviewable), decisions);
  if (review.errors.length > 0) throw new Error(`review failed: ${review.errors.join(", ")}`);

  const categories = new Map(
    fixture.context.lines.map((line) => [line.id, line.ingredient?.category ?? null]),
  );
  const proposedById = new Map(plan.items.map((item) => [item.id, item]));
  const rows = review.items.map((item) => {
    const proposed = proposedById.get(item.id) as ProposedItem;
    return toPushRow(item, proposed, categories.get(proposed.listItemId) ?? null);
  });
  const pushed = await pushRun(
    {
      runId: ctx.runId,
      store,
      connection,
      policy,
      allergies: ctx.allergies,
      approvedSubtotalUsd: review.subtotalUsd,
    },
    rows,
    { adapter: target, ledger: memoryLedger(rows), now },
  );
  const cart = target.getCart
    ? (await target.getCart(connection)).items
        .map((item) => ({ productId: item.productId, quantity: item.quantity }))
        .sort((a, b) => a.productId.localeCompare(b.productId))
    : rows
        .filter((row) => row.cartQty > 0 && row.productId)
        .map((row) => ({ productId: row.productId ?? "", quantity: row.cartQty }))
        .sort((a, b) => a.productId.localeCompare(b.productId));
  const lineOf = new Map(plan.items.map((item) => [item.id, item.listItemId]));
  return {
    planned: summarizePlanned(plan.items),
    toolCalls: plan.toolCalls,
    modelCalls: model.calls(),
    costUsd: Math.round(plan.model.costUsd * 1e6) / 1e6,
    finalStatus: pushed.status === "stopped" ? "running" : pushed.status,
    ledger: rows.map((row) => ({
      listItemId: lineOf.get(row.id) ?? row.id,
      cartQty: row.cartQty,
      deltaResult: row.deltaResult,
    })),
    cart,
    ranOut: model.ranOut(),
  };
}
