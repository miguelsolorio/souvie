import { DEFAULT_RUN_POLICY } from "@mp/core";
import type { CartItemDelta, RetailerAdapter } from "@mp/retailers";
import { MockRetailer } from "@mp/retailers/mock";
import { describe, expect, it } from "vitest";
import { type LedgerStore, planDeltas, RESULT_OK } from "./ledger.ts";
import { memoryLedger, storeById, toPushRow, toReviewable, withCapabilities } from "./replay.ts";
import { applyReview } from "./review.ts";
import { type PushContext, type PushRow, planRun, pushRun } from "./run.ts";
import {
  connectionFor,
  context,
  line,
  MOCK_STORE_ID,
  ONTOLOGY,
  twelveLines,
} from "./testing/fixtures.ts";

/** Twelve lines that all match, so the push has twelve rows in list order. */
function twelveMatching() {
  return twelveLines().map((l) =>
    l.id === "L10" ? line("L10", "Penne", 16, "oz", ONTOLOGY.penne) : l,
  );
}

/** Records every delta the adapter receives. */
function recording(adapter: RetailerAdapter) {
  const sent: CartItemDelta[] = [];
  const wrapped: RetailerAdapter = {
    ...adapter,
    capabilities: adapter.capabilities,
    findStores: (z, o) => adapter.findStores(z, o),
    searchProducts: (q, s, o) => adapter.searchProducts(q, s, o),
    getProducts: (ids, s) => adapter.getProducts(ids, s),
    connect: (c) => adapter.connect(c),
    addToCart: async (conn, items) => {
      sent.push(...items);
      return adapter.addToCart(conn, items);
    },
  };
  if (adapter.getCart) wrapped.getCart = (c) => adapter.getCart?.(c) as never;
  if (adapter.handoffUrl) wrapped.handoffUrl = (c, r) => adapter.handoffUrl?.(c, r) as never;
  return { adapter: wrapped, sent };
}

async function approvedRows(lines = twelveMatching()) {
  const mock = new MockRetailer({ seed: 1 });
  const store = await storeById(mock, MOCK_STORE_ID);
  let n = 0;
  const plan = await planRun(context(store, lines), {
    adapter: mock,
    callModel: null,
    newId: () => `row-${String(++n).padStart(2, "0")}`,
  });
  const review = applyReview(plan.items.map(toReviewable), []);
  const byId = new Map(plan.items.map((i) => [i.id, i]));
  const rows: PushRow[] = review.items.map((item) => {
    const proposed = byId.get(item.id);
    if (!proposed) throw new Error("missing");
    return toPushRow(item, proposed, null);
  });
  const ctx: PushContext = {
    runId: "run-test",
    store,
    connection: connectionFor(store),
    policy: DEFAULT_RUN_POLICY,
    allergies: [],
    approvedSubtotalUsd: review.subtotalUsd,
  };
  return { mock, store, rows, ctx };
}

/** A ledger that dies (the worker process ends) before writing the nth row's delta. */
function dyingLedger(rows: PushRow[], dieBeforeRow: number): LedgerStore {
  const inner = memoryLedger(rows);
  let started = 0;
  return {
    async markSent(id, deltaSent, sentAt) {
      started += 1;
      if (started === dieBeforeRow) throw new Error("worker killed");
      await inner.markSent(id, deltaSent, sentAt);
    },
    markResult: inner.markResult,
  };
}

describe("the write ledger (Kroger shape: add-only, no cart read)", () => {
  it("resumes after a crash between item 5 and 6 by sending only items 6 to 12", async () => {
    const { mock, rows, ctx } = await approvedRows();
    expect(rows.filter((r) => r.productId)).toHaveLength(12);
    const krogerLike = withCapabilities(mock, {
      cartRead: "none",
      slots: "handoff",
      checkout: "handoff",
    });

    const first = recording(krogerLike);
    await expect(
      pushRun(ctx, rows, { adapter: first.adapter, ledger: dyingLedger(rows, 6) }),
    ).rejects.toThrow("worker killed");
    expect(first.sent).toHaveLength(5);
    expect(rows.slice(0, 5).every((r) => r.deltaResult === RESULT_OK && r.cartQty === r.qty)).toBe(
      true,
    );
    expect(rows.slice(5).every((r) => r.deltaSent === null && r.cartQty === 0)).toBe(true);

    const resumed = recording(krogerLike);
    const result = await pushRun(ctx, rows, {
      adapter: resumed.adapter,
      ledger: memoryLedger(rows),
    });
    expect(result.status).toBe("cart_ready");
    expect(resumed.sent.map((d) => d.productId)).toEqual(rows.slice(5).map((r) => r.productId));
    expect(resumed.sent.every((d) => d.quantityDelta > 0)).toBe(true);
    expect(rows.every((r) => r.deltaResult === RESULT_OK && r.cartQty === r.qty)).toBe(true);

    // The retailer's cart holds each product once, at the approved quantity.
    const cart = await mock.getCart(ctx.connection);
    expect(cart.items).toHaveLength(12);
    for (const row of rows) {
      expect(cart.items.find((i) => i.productId === row.productId)?.quantity).toBe(row.qty);
    }
    expect(result.handoffUrl).toMatch(/^https:\/\/mock-retailer\.test\/checkout/);
    expect(result.push).toMatchObject({
      type: "cart_ready",
      runId: "run-test",
      storeName: "Mock QFC Duvall",
    });
  });

  it("resends a call that was in flight when the worker died, with the same delta", async () => {
    const { mock, rows, ctx } = await approvedRows();
    const krogerLike = withCapabilities(mock, { cartRead: "none" });
    let calls = 0;
    const flaky: RetailerAdapter = {
      ...recording(krogerLike).adapter,
      addToCart: async (conn, items) => {
        calls += 1;
        if (calls === 3) throw new TypeError("socket hang up");
        return krogerLike.addToCart(conn, items);
      },
    };
    await expect(
      pushRun(ctx, rows, { adapter: flaky, ledger: memoryLedger(rows) }),
    ).rejects.toThrow("socket hang up");
    const third = rows[2];
    expect(third?.deltaSent).toBe(third?.qty);
    expect(third?.deltaResult).toBeNull();
    expect(planDeltas(rows).find((p) => p.row.id === third?.id)).toMatchObject({
      resend: true,
      delta: third?.qty,
    });

    const resumed = recording(krogerLike);
    await pushRun(ctx, rows, { adapter: resumed.adapter, ledger: memoryLedger(rows) });
    expect(resumed.sent).toHaveLength(10);
    expect(resumed.sent[0]?.productId).toBe(third?.productId);
  });

  it("a quantity change from 2 to 1 after the push sends a delta of -1", async () => {
    const { mock, rows, ctx } = await approvedRows();
    const krogerLike = withCapabilities(mock, { cartRead: "none" });
    await pushRun(ctx, rows, { adapter: krogerLike, ledger: memoryLedger(rows) });
    const two = rows.find((r) => r.qty === 2);
    expect(two).toBeDefined();
    if (!two) return;
    expect(two.cartQty).toBe(2);
    two.qty = 1;

    const again = recording(krogerLike);
    await pushRun(ctx, rows, { adapter: again.adapter, ledger: memoryLedger(rows) });
    expect(again.sent).toEqual([
      { productId: two.productId, upc: two.upc, quantityDelta: -1, modality: "PICKUP" },
    ]);
    expect(two.cartQty).toBe(1);
    expect(two.deltaSent).toBe(1);
    const cart = await mock.getCart(ctx.connection);
    expect(cart.items.find((i) => i.productId === two.productId)?.quantity).toBe(1);
  });

  it("removing a pushed line sends its whole quantity back, and never more", async () => {
    const { mock, rows, ctx } = await approvedRows();
    const krogerLike = withCapabilities(mock, { cartRead: "none" });
    await pushRun(ctx, rows, { adapter: krogerLike, ledger: memoryLedger(rows) });
    const first = rows[0];
    if (!first) throw new Error("no rows");
    first.userDecision = "removed";
    const again = recording(krogerLike);
    await pushRun(ctx, rows, { adapter: again.adapter, ledger: memoryLedger(rows) });
    expect(again.sent.map((d) => d.quantityDelta)).toEqual([-(first.qty ?? 0)]);
    expect(first.cartQty).toBe(0);
  });

  it("pauses at needs_review on quota, writing that the call did not happen", async () => {
    const { mock, rows, ctx } = await approvedRows();
    const krogerLike = withCapabilities(mock, { cartRead: "none" });
    mock.setFailure("addToCart", "quota");
    const result = await pushRun(ctx, rows, { adapter: krogerLike, ledger: memoryLedger(rows) });
    expect(result.status).toBe("needs_review");
    expect(result.flags.map((f) => f.kind)).toContain("quota");
    expect(rows[0]?.deltaResult).toBe("quota");
    expect(rows[0]?.cartQty).toBe(0);
    expect(rows[0]?.deltaSent).toBe(0);
    mock.setFailure("addToCart", null);
    const later = recording(krogerLike);
    await pushRun(ctx, rows, { adapter: later.adapter, ledger: memoryLedger(rows) });
    expect(later.sent).toHaveLength(12);
  });

  it("checks allergens again on the products the retailer returns today, and skips a failing one", async () => {
    const { mock, rows, ctx } = await approvedRows();
    const result = await pushRun({ ...ctx, allergies: ["milk"] }, rows, {
      adapter: mock,
      ledger: memoryLedger(rows),
    });
    const milk = rows.find((r) => r.displayName === "Whole milk");
    expect(milk?.cartQty).toBe(0);
    expect(milk?.deltaSent).toBeNull();
    expect(result.rowFlags.get(milk?.id ?? "")?.map((f) => f.kind)).toEqual(["allergen"]);
  });

  it("records the retailer's refusal and keeps going", async () => {
    const { mock, rows, ctx } = await approvedRows();
    const first = rows[0];
    if (!first) throw new Error("no rows");
    const adapter: RetailerAdapter = {
      ...recording(mock).adapter,
      addToCart: async (conn, items) =>
        items[0]?.productId === first.productId
          ? { accepted: [], rejected: [{ item: items[0], reason: "not sold online" }] }
          : mock.addToCart(conn, items),
    };
    const result = await pushRun(ctx, rows, { adapter, ledger: memoryLedger(rows) });
    expect(result.status).toBe("cart_ready");
    expect(first.deltaResult).toBe("rejected: not sold online");
    expect(first.cartQty).toBe(0);
    expect(result.flags.map((f) => f.kind)).toContain("cart_rejected");
  });
});

describe("with a readable cart (the mock, browser adapters)", () => {
  it("diffs against the live cart instead of the ledger, and resumes the same way", async () => {
    const { mock, rows, ctx } = await approvedRows();
    await expect(
      pushRun(ctx, rows, { adapter: mock, ledger: dyingLedger(rows, 6) }),
    ).rejects.toThrow("worker killed");
    const resumed = recording(mock);
    await pushRun(ctx, rows, { adapter: resumed.adapter, ledger: memoryLedger(rows) });
    expect(resumed.sent.map((d) => d.productId)).toEqual(rows.slice(5).map((r) => r.productId));
    expect(mock.calls.some((c) => c.operation === "getCart")).toBe(true);
  });

  it("does not take out what the person put in the cart themselves", () => {
    const row: PushRow = {
      id: "r",
      position: 1,
      displayName: "Milk",
      productId: "p",
      upc: null,
      qty: 1,
      status: "matched",
      userDecision: "removed",
      cartQty: 0,
      deltaSent: null,
      deltaResult: null,
      sentAt: null,
      unitPriceUsd: 4,
    };
    expect(planDeltas([row], new Map([["p", 3]]))).toEqual([]);
  });
});
