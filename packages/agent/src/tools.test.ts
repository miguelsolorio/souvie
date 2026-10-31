import { DEFAULT_RUN_POLICY } from "@mp/core";
import { KROGER_CAPABILITIES, MOCK_CAPABILITIES } from "@mp/retailers";
import { MockRetailer } from "@mp/retailers/mock";
import { describe, expect, it } from "vitest";
import { storeById, withCapabilities } from "./replay.ts";
import { applyReview, type ReviewableItem } from "./review.ts";
import { continueCheckout } from "./run.ts";
import { connectionFor, MOCK_STORE_ID } from "./testing/fixtures.ts";
import {
  availableTools,
  checkToolAccess,
  TOOL_NAMES,
  TOOL_SPECS,
  toolDefinitions,
} from "./tools.ts";
import { MAX_TRANSCRIPT_ENTRIES, redactInput, Transcript } from "./transcript.ts";

const BROWSER = {
  ...MOCK_CAPABILITIES,
  search: "browser",
  cartAdd: "browser",
  cartRead: "browser",
  slots: "browser",
  checkout: "browser",
} as const;

describe("tool definitions", () => {
  it("are strict, closed objects, one per tool in the brief's table", () => {
    expect(TOOL_NAMES).toEqual([
      "find_store",
      "search_products",
      "get_product",
      "choose_product",
      "mark_unmatched",
      "request_review",
      "add_to_cart",
      "set_quantity",
      "remove_from_cart",
      "view_cart",
      "get_slots",
      "select_slot",
      "checkout",
      "finish",
    ]);
    for (const def of toolDefinitions(TOOL_NAMES)) {
      expect(def.strict).toBe(true);
      expect(def.input_schema).toMatchObject({ type: "object", additionalProperties: false });
      // strict mode takes no numeric bounds; limits live in code.
      expect(JSON.stringify(def.input_schema)).not.toMatch(/maximum|minimum|minLength|maxLength/);
    }
    expect(TOOL_SPECS.choose_product.input_schema).toMatchObject({
      required: ["listItemId", "candidateIndex", "quantity"],
      properties: { candidateIndex: { type: "integer" } },
    });
  });
});

describe("capability, then state, then the review gate", () => {
  const planning = { status: "running" as const, phase: "planning" as const, approved: false };
  const push = { status: "running" as const, phase: "push" as const, approved: true };
  const cartReady = { status: "cart_ready" as const, phase: "checkout" as const, approved: true };

  it("offers Kroger's planning tools and refuses slots and checkout as a hand-off", () => {
    expect(availableTools(KROGER_CAPABILITIES, planning)).toEqual([
      "find_store",
      "search_products",
      "get_product",
      "choose_product",
      "mark_unmatched",
      "request_review",
    ]);
    const slots = checkToolAccess("get_slots", KROGER_CAPABILITIES, cartReady);
    expect(slots).toMatchObject({
      ok: false,
      error: "not_supported",
      capability: "slots",
      value: "handoff",
    });
    expect(slots.ok ? "" : slots.hint).toMatch(/hands this step to the person/);
    expect(checkToolAccess("checkout", KROGER_CAPABILITIES, cartReady)).toMatchObject({
      ok: false,
      error: "not_supported",
    });
    expect(checkToolAccess("view_cart", KROGER_CAPABILITIES, push)).toMatchObject({
      ok: false,
      error: "not_supported",
      capability: "cartRead",
    });
    // remove_from_cart works with a negative delta where the cart cannot be read.
    expect(checkToolAccess("remove_from_cart", KROGER_CAPABILITIES, push)).toEqual({ ok: true });
  });

  it("refuses a cart write in the planning phase and before approval", () => {
    expect(checkToolAccess("add_to_cart", KROGER_CAPABILITIES, planning)).toMatchObject({
      ok: false,
      error: "wrong_state",
    });
    expect(
      checkToolAccess("add_to_cart", KROGER_CAPABILITIES, { ...push, approved: false }),
    ).toMatchObject({ ok: false, error: "needs_approval" });
    expect(checkToolAccess("add_to_cart", KROGER_CAPABILITIES, push)).toEqual({ ok: true });
  });

  it("enables checkout only for a browser checkout after the review gate", () => {
    expect(checkToolAccess("checkout", MOCK_CAPABILITIES, cartReady)).toMatchObject({
      ok: false,
      error: "not_supported",
    });
    expect(checkToolAccess("checkout", BROWSER, cartReady)).toEqual({ ok: true });
    expect(checkToolAccess("checkout", BROWSER, { ...cartReady, approved: false })).toMatchObject({
      ok: false,
      error: "needs_approval",
    });
    expect(checkToolAccess("checkout", BROWSER, { ...cartReady, status: "running" })).toMatchObject(
      { ok: false, error: "wrong_state" },
    );
  });
});

describe("Tier 3 checkout plumbing", () => {
  it("stops at the hand-off for Kroger, and checks out a browser store only with approval or the auto cap", async () => {
    const mock = new MockRetailer({ seed: 1 });
    const store = await storeById(mock, MOCK_STORE_ID);
    const connection = connectionFor(store);
    await mock.addToCart(connection, [
      { productId: "0099020000001", upc: "0099020000001", quantityDelta: 1 },
    ]);
    const base = {
      runId: "r",
      store,
      connection,
      allergies: [],
      approvedSubtotalUsd: 4.29,
      approved: true,
      cartSubtotalUsd: 4.29,
    };
    const transitions: string[] = [];
    const transition = async (to: string) => {
      transitions.push(to);
    };

    const kroger = withCapabilities(mock, KROGER_CAPABILITIES);
    const handoff = await continueCheckout(
      { ...base, policy: DEFAULT_RUN_POLICY },
      { adapter: kroger, transition, personApproved: true },
    );
    expect(handoff).toMatchObject({ status: "cart_ready", waiting: "handoff" });

    const browser = withCapabilities(mock, BROWSER);
    const waiting = await continueCheckout(
      { ...base, policy: DEFAULT_RUN_POLICY },
      { adapter: browser, transition, personApproved: false },
    );
    expect(waiting).toMatchObject({ status: "cart_ready", waiting: "approval" });

    const auto = await continueCheckout(
      {
        ...base,
        policy: { ...DEFAULT_RUN_POLICY, auto_checkout: true, auto_checkout_cap_usd: 50 },
      },
      { adapter: browser, transition, personApproved: false },
    );
    expect(auto.status).toBe("checked_out");
    expect(auto.orderRef).toBe("MOCK-ORDER-1");
    expect(transitions).toEqual(["checking_out"]);
    expect(auto.transcript.map((e) => e.tool)).toEqual([
      "get_slots",
      "select_slot",
      "checkout",
      "finish",
    ]);
  });
});

describe("transcript", () => {
  it("keeps only allowed keys, short values, and never product data", () => {
    expect(
      redactInput({
        listItemId: "L1",
        candidateIndex: 2,
        name: "Northfork Whole Milk",
        upc: "009",
        reason: "cheapest $4.29",
        query: "x".repeat(300),
      }),
    ).toEqual({ listItemId: "L1", candidateIndex: 2, query: "x".repeat(120) });
  });

  it("stops at its limit with one note", async () => {
    const appended: unknown[] = [];
    const t = new Transcript(
      { append: async (entries) => void appended.push(...entries) },
      () => 0,
    );
    for (let i = 0; i < MAX_TRANSCRIPT_ENTRIES + 5; i++) {
      t.record({ tool: "search_products", by: "host", input: {}, output_summary: "x", ok: true });
    }
    await t.flush();
    await t.flush();
    expect(appended).toHaveLength(MAX_TRANSCRIPT_ENTRIES + 1);
    expect(t.entries().at(-1)?.tool).toBe("transcript");
  });
});

describe("review", () => {
  const base: ReviewableItem = {
    id: "a",
    status: "matched",
    productId: "p1",
    upc: "0000000000001",
    productName: "First",
    size: "1 lb",
    qty: 2,
    unitPriceUsd: 3,
    lineTotalUsd: 6,
    alternatives: [
      { product_id: "p2", upc: "0000000000002", name: "Second", size: "2 lb", price: 5, qty: 1 },
    ],
    userDecision: null,
  };

  it("keeps, swaps to an alternative by index, removes, and changes quantities", () => {
    const items: ReviewableItem[] = [
      base,
      { ...base, id: "b" },
      { ...base, id: "c" },
      { ...base, id: "d" },
      {
        ...base,
        id: "e",
        status: "unmatched",
        productId: null,
        productName: null,
        qty: null,
        lineTotalUsd: null,
      },
    ];
    const result = applyReview(items, [
      { runItemId: "b", action: "swap", alternativeIndex: 0 },
      { runItemId: "c", action: "remove" },
      { runItemId: "d", action: "quantity", quantity: 1 },
    ]);
    expect(result.errors).toEqual([]);
    const [a, b, c, d, e] = result.items;
    expect(a).toMatchObject({ userDecision: "accepted", lineTotalUsd: 6 });
    expect(b).toMatchObject({ userDecision: "swapped", productId: "p2", qty: 1, lineTotalUsd: 5 });
    expect(b?.alternatives?.map((x) => x.product_id)).toEqual(["p1"]);
    expect(c).toMatchObject({ userDecision: "removed", status: "removed" });
    expect(d).toMatchObject({ userDecision: "accepted", qty: 1, lineTotalUsd: 3 });
    expect(e?.userDecision).toBeNull();
    expect(result.subtotalUsd).toBe(14);
    expect(result.cartLines).toBe(3);
  });

  it("refuses an alternative that is not on the line, a bad quantity, and an unknown row", () => {
    const result = applyReview(
      [base],
      [
        { runItemId: "a", action: "swap", alternativeIndex: 3 },
        { runItemId: "a", action: "quantity", quantity: 0 },
        { runItemId: "zzz", action: "keep" },
      ],
    );
    expect(result.errors).toEqual([
      "unknown_alternative:a",
      "invalid_quantity:a",
      "unknown_item:zzz",
    ]);
  });
});
