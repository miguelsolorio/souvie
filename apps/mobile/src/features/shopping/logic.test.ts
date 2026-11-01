import { describe, expect, it } from "vitest";
import {
  failureText,
  groupBySection,
  inCartCount,
  overBudget,
  overlayRun,
  preview,
  progressText,
  type RunItem,
  remove,
  restore,
  setQuantity,
  swap,
  toDecisions,
  toItem,
  toRun,
  transcriptLines,
} from "./logic";
import { routeForPush, runRoute } from "./routes";

function item(fields: Partial<RunItem> & Pick<RunItem, "id" | "position" | "section">): RunItem {
  return {
    run_id: "r",
    display_name: `Line ${fields.position}`,
    product_id: `p${fields.position}`,
    upc: null,
    product_name: `Product ${fields.position}`,
    size: "1 lb",
    qty: 1,
    unit_price_usd: 2,
    line_total_usd: 2,
    status: "matched",
    alternatives: [
      {
        product_id: `a${fields.position}`,
        upc: null,
        name: "Alt",
        size: "2 lb",
        price: 3.5,
        qty: 1,
      },
    ],
    user_decision: null,
    flags: [],
    reason: null,
    cart_qty: 0,
    delta_result: null,
    ...fields,
  };
}

const items = [
  item({ id: "1", position: 0, section: "dairy" }),
  item({ id: "2", position: 1, section: "produce" }),
  item({ id: "3", position: 2, section: "produce", qty: 2, line_total_usd: 4 }),
];

describe("the review draft", () => {
  it("previews the approved subtotal with the server's own review", () => {
    let draft = swap({}, "1", 0);
    draft = remove(draft, "2");
    draft = setQuantity(draft, "3", 1);
    const p = preview(items, draft);
    expect(p.errors).toEqual([]);
    expect(p.subtotalUsd).toBe(5.5);
    expect(p.cartLines).toBe(2);
    expect(p.items.get("1")?.productName).toBe("Alt");
    expect(toDecisions(items, draft)).toEqual([
      { runItemId: "1", action: "swap", alternativeIndex: 0 },
      { runItemId: "2", action: "remove" },
      { runItemId: "3", action: "quantity", quantity: 1 },
    ]);
  });

  it("toggles a swap off, keeps the quantity of a swapped line, and restores a removed line", () => {
    expect(swap(swap({}, "1", 0), "1", 0)).toEqual({});
    expect(setQuantity(swap({}, "1", 0), "1", 3)).toEqual({
      "1": { action: "swap", alternativeIndex: 0, quantity: 3 },
    });
    expect(
      toDecisions(items, { "1": { action: "swap", alternativeIndex: 0, quantity: 3 } }),
    ).toEqual([
      { runItemId: "1", action: "swap", alternativeIndex: 0 },
      { runItemId: "1", action: "quantity", quantity: 3 },
    ]);
    expect(restore(remove({}, "2"), "2")).toEqual({});
  });

  it("says when the cart is over the budget", () => {
    expect(overBudget(41, { budget_cap_usd: 40 })).toBe(40);
    expect(overBudget(39, { budget_cap_usd: 40 })).toBeNull();
    expect(overBudget(500, { budget_cap_usd: null })).toBeNull();
  });
});

describe("rows and copy", () => {
  it("groups lines by store section in aisle order", () => {
    expect(groupBySection(items).map((g) => [g.section, g.items.map((i) => i.id)])).toEqual([
      ["produce", ["2", "3"]],
      ["dairy", ["1"]],
    ]);
  });

  it("reads numeric columns that arrive as text", () => {
    expect(
      toItem({
        id: "x",
        qty: "2",
        unit_price_usd: "3.49",
        line_total_usd: "6.98",
        cart_qty: "0",
        flags: null,
        alternatives: null,
      }),
    ).toMatchObject({
      qty: 2,
      unit_price_usd: 3.49,
      line_total_usd: 6.98,
      flags: [],
      alternatives: null,
    });
    expect(toRun({ id: "r", subtotal_usd: "142.17", transcript: null }).subtotal_usd).toBe(142.17);
  });

  it("explains progress and failure in plain words", () => {
    expect(
      progressText({
        status: "running",
        approved_at: null,
        progress: { done: 3, total: 12 },
        error: null,
      }),
    ).toBe("Finding products: 3 of 12 items.");
    expect(
      progressText({
        status: "running",
        approved_at: "x",
        progress: { done: 7, total: 12 },
        error: null,
      }),
    ).toBe("Adding to your cart: 7 of 12.");
    expect(failureText("needs_reauth: the store connection needs a new sign-in")).toMatch(
      /new sign-in/,
    );
    expect(failureText("stalled: no heartbeat for 90 seconds")).toMatch(/stopped answering/);
    expect(failureText("stalled: no heartbeat for 90 seconds")).not.toMatch(/store cart/);
  });

  it("warns that items may be in the cart when a failed run already added some", () => {
    const failed = {
      status: "failed" as const,
      approved_at: "x",
      progress: null,
      error: "stalled: no heartbeat for 90 seconds",
    };
    expect(progressText(failed, { itemsInCart: true })).toBe(
      "The shopper stopped answering. Try again. Some items may already be in your store cart, so check it first.",
    );
    expect(progressText(failed)).toBe("The shopper stopped answering. Try again.");
    expect(inCartCount([{ cart_qty: 2 }, { cart_qty: 0 }, { cart_qty: 1 }])).toBe(2);
  });

  it("warns the same way when a run that pushed part of its cart was cancelled (a review that timed out)", () => {
    const cancelled = {
      status: "cancelled" as const,
      approved_at: null,
      progress: null,
      error: "review timed out",
    };
    expect(progressText(cancelled, { itemsInCart: true })).toBe(
      "This run was cancelled. Some items may already be in your store cart, so check it first.",
    );
    expect(progressText(cancelled, { itemsInCart: false })).toBe("This run was cancelled.");
    expect(progressText(cancelled)).toBe("This run was cancelled.");
  });

  it("does not say the store cart is empty when a stopped push left items in it", () => {
    const review = {
      status: "needs_review" as const,
      approved_at: null,
      progress: null,
      error: null,
    };
    expect(progressText(review)).toMatch(/Nothing is in your store cart yet/);
    expect(progressText(review, { itemsInCart: true })).toMatch(/already in your store cart/);
    expect(progressText(review, { itemsInCart: true })).not.toMatch(/Nothing is in/);
  });

  it("lays a Realtime change over the cached run without wiping what it leaves out", () => {
    const held = toRun({
      id: "r",
      status: "running",
      subtotal_usd: "64.30",
      transcript: [{ ts: "t", tool: "search_products", by: "host", output_summary: "s", ok: true }],
      cart_snapshot: { summary: "kept" },
    });
    const next = overlayRun(held, { id: "r", status: "cart_ready", heartbeat_at: null });
    expect(next.status).toBe("cart_ready");
    expect(next.transcript).toHaveLength(1);
    expect(next.cart_snapshot).toEqual({ summary: "kept" });
    expect(next.subtotal_usd).toBe(64.3);
    const full = overlayRun(held, { subtotal_usd: "60.10", cart_snapshot: null, transcript: [] });
    expect(full.subtotal_usd).toBe(60.1);
    expect(full.cart_snapshot).toBeNull();
    expect(full.transcript).toEqual([]);
  });

  it("formats the transcript", () => {
    expect(
      transcriptLines([
        {
          ts: "2026-10-31T16:00:05.000Z",
          tool: "search_products",
          by: "host",
          output_summary: "3 candidates.",
          ok: true,
        },
      ]),
    ).toEqual([
      {
        key: "0-2026-10-31T16:00:05.000Z",
        time: "16:00:05",
        who: "Shopper",
        tool: "search products",
        text: "3 candidates.",
        ok: true,
      },
    ]);
  });

  it("opens the run a notification names, and nothing else", () => {
    const id = "5a000000-0000-4000-8000-0000000000aa";
    expect(routeForPush({ type: "cart_ready", runId: id })).toBe(runRoute(id));
    expect(routeForPush({ type: "needs_review", runId: id, count: 2 })).toBe(`/shopping/${id}`);
    expect(routeForPush({ type: "run_failed", runId: id, scheduled: true })).toBe(
      `/shopping/${id}`,
    );
    expect(routeForPush({ type: "marketing", runId: id })).toBeNull();
    expect(routeForPush({ type: "cart_ready", runId: "../../evil" })).toBeNull();
    expect(routeForPush(null)).toBeNull();
  });

  it("sends the other pushes where the person can act on them", () => {
    const id = "5a000000-0000-4000-8000-0000000000aa";
    expect(routeForPush({ type: "schedule_skipped", scheduleId: id, reason: "missed" })).toBe(
      "/schedules",
    );
    expect(routeForPush({ type: "weekly_nudge", weekStart: "2026-11-09" })).toBe(
      "/plan?week=2026-11-09",
    );
    expect(routeForPush({ type: "weekly_nudge", weekStart: "../../evil" })).toBe("/plan");
    expect(routeForPush({ type: "pickup_reminder", runId: id })).toBe(`/shopping/${id}`);
    expect(routeForPush({ type: "pickup_reminder", runId: null })).toBe("/shopping");
    expect(routeForPush({ type: "import_finished", recipeId: id })).toBe(`/recipes/${id}`);
    expect(routeForPush({ type: "import_finished", recipeId: "../x" })).toBe("/recipes");
  });
});
