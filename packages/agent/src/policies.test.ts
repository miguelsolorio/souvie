import { DEFAULT_RUN_POLICY } from "@mp/core";
import { MockRetailer } from "@mp/retailers/mock";
import { describe, expect, it } from "vitest";
import type { LedgerRow } from "./ledger.ts";
import { prepareLine, proposeItem } from "./planner.ts";
import {
  assertWithinBudget,
  budgetFlag,
  canAutoCheckout,
  checkSubstitution,
  itemCeilingFlag,
  PolicyViolation,
  resolvePolicy,
} from "./policies.ts";
import { memoryLedger, storeById } from "./replay.ts";
import { type PushRow, planRun, pushRun } from "./run.ts";
import {
  connectionFor,
  context,
  line,
  MOCK_STORE_ID,
  ONTOLOGY,
  product,
  twelveLines,
} from "./testing/fixtures.ts";
import { NO_PREFERENCES } from "./types.ts";

async function mockStore() {
  const mock = new MockRetailer({ seed: 1 });
  return { mock, store: await storeById(mock, MOCK_STORE_ID) };
}

describe("budget_cap_usd", () => {
  it("a proposed cart over the cap goes to needs_review with a budget flag", async () => {
    const { mock, store } = await mockStore();
    const result = await planRun(
      context(store, twelveLines(), { policy: { budget_cap_usd: 20 } }),
      {
        adapter: mock,
        callModel: null,
      },
    );
    expect(result.status).toBe("needs_review");
    expect(result.subtotalUsd).toBeGreaterThan(20);
    expect(result.snapshot.flags.map((f) => f.kind)).toContain("budget");
    expect(budgetFlag({ budget_cap_usd: 20 }, 19.99)).toBeNull();
  });

  it("an approved cart over the cap is never pushed", async () => {
    const { mock, store } = await mockStore();
    const row: PushRow = {
      id: "r1",
      position: 1,
      displayName: "Milk",
      productId: "0099020000001",
      upc: "0099020000001",
      qty: 10,
      status: "matched",
      userDecision: "accepted",
      cartQty: 0,
      deltaSent: null,
      deltaResult: null,
      sentAt: null,
      unitPriceUsd: 4.29,
    };
    const result = await pushRun(
      {
        runId: "r",
        store,
        connection: connectionFor(store),
        policy: { ...DEFAULT_RUN_POLICY, budget_cap_usd: 30 },
        allergies: [],
        approvedSubtotalUsd: 42.9,
      },
      [row],
      { adapter: mock, ledger: memoryLedger([row]) },
    );
    expect(result.status).toBe("needs_review");
    expect(result.flags.map((f) => f.kind)).toEqual(["budget"]);
    expect(mock.calls.some((c) => c.operation === "addToCart")).toBe(false);
    expect((row as LedgerRow).deltaSent).toBeNull();
    expect(() => assertWithinBudget({ budget_cap_usd: 30 }, 42.9)).toThrow(PolicyViolation);
  });
});

describe("per_item_ceiling_usd", () => {
  it("flags a line over the ceiling", async () => {
    const { mock, store } = await mockStore();
    const result = await planRun(
      context(store, twelveLines(), { policy: { per_item_ceiling_usd: 10 } }),
      {
        adapter: mock,
        callModel: null,
      },
    );
    const salmon = result.items.find((i) => i.listItemId === "L11");
    expect(salmon?.lineTotalUsd).toBeGreaterThan(10);
    expect(salmon?.flags.map((f) => f.kind)).toContain("over_item_ceiling");
    const milk = result.items.find((i) => i.listItemId === "L04");
    expect(milk?.flags.map((f) => f.kind)).not.toContain("over_item_ceiling");
    expect(itemCeilingFlag({ per_item_ceiling_usd: null }, 500)).toBeNull();
  });
});

describe("substitution", () => {
  const pinned = { productId: "P", brand: "Northfork Creamery" };
  const sameBrand = product({
    id: "S",
    name: "Northfork Creamery Whole Milk",
    brand: "Northfork Creamery",
  });
  const otherBrand = product({ id: "O", name: "Mock Market Whole Milk", brand: "Mock Market" });

  it("none rejects a candidate whose brand differs from the pinned match, and any other product", () => {
    expect(checkSubstitution({ substitution: "none" }, pinned, otherBrand).allowed).toBe(false);
    expect(checkSubstitution({ substitution: "none" }, pinned, sameBrand).allowed).toBe(false);
    expect(
      checkSubstitution({ substitution: "none" }, pinned, { id: "P", brand: "Northfork Creamery" })
        .allowed,
    ).toBe(true);
  });

  it("same_brand allows only the pinned brand, any allows everything", () => {
    expect(checkSubstitution({ substitution: "same_brand" }, pinned, sameBrand).allowed).toBe(true);
    expect(checkSubstitution({ substitution: "same_brand" }, pinned, otherBrand).allowed).toBe(
      false,
    );
    expect(
      checkSubstitution({ substitution: "same_brand" }, { productId: "P", brand: null }, sameBrand)
        .allowed,
    ).toBe(false);
    const any = checkSubstitution({ substitution: "any" }, pinned, otherBrand);
    expect(any).toMatchObject({ allowed: true, substitution: true, crossesBrand: true });
  });

  it("with nothing pinned there is nothing to substitute", () => {
    expect(checkSubstitution({ substitution: "none" }, null, otherBrand)).toMatchObject({
      allowed: true,
      substitution: false,
    });
  });

  it("narrows a line's candidates and marks the result substituted, flagged when it crosses brands", () => {
    const milk = line("M", "Whole milk", 1, "gallon", ONTOLOGY.milk);
    const base = {
      pinnedProductId: "P",
      pastPickIds: new Set<string>(),
      preferences: NO_PREFERENCES,
      reference: pinned,
      allergies: [] as never[],
    };
    const none = prepareLine(milk, [sameBrand, otherBrand], {
      ...base,
      policy: { substitution: "none" },
    });
    expect(none.ranked).toEqual([]);
    expect(none.excluded.substitution).toBe(2);
    const anyLine = prepareLine(milk, [otherBrand], { ...base, policy: { substitution: "any" } });
    const item = proposeItem(
      "x",
      anyLine,
      { kind: "chosen", index: 0, units: 1, by: "host", reason: null },
      { ...DEFAULT_RUN_POLICY, substitution: "any" },
    );
    expect(item.status).toBe("substituted");
    expect(item.flags.map((f) => f.kind)).toContain("substitution");
  });
});

describe("auto_checkout and the stored policy", () => {
  it("checks out without a tap only on a browser checkout, after review, under the cap", () => {
    const policy = { ...DEFAULT_RUN_POLICY, auto_checkout: true, auto_checkout_cap_usd: 150 };
    expect(
      canAutoCheckout(policy, { checkout: "browser" }, { approved: true, subtotalUsd: 120 }),
    ).toBe(true);
    expect(
      canAutoCheckout(policy, { checkout: "browser" }, { approved: false, subtotalUsd: 120 }),
    ).toBe(false);
    expect(
      canAutoCheckout(policy, { checkout: "browser" }, { approved: true, subtotalUsd: 151 }),
    ).toBe(false);
    expect(
      canAutoCheckout(policy, { checkout: "handoff" }, { approved: true, subtotalUsd: 10 }),
    ).toBe(false);
    expect(
      canAutoCheckout(
        DEFAULT_RUN_POLICY,
        { checkout: "browser" },
        { approved: true, subtotalUsd: 10 },
      ),
    ).toBe(false);
  });

  it("fails closed on a stored policy that is not a RunPolicy", () => {
    expect(resolvePolicy({})).toEqual(DEFAULT_RUN_POLICY);
    expect(resolvePolicy(null)).toEqual(DEFAULT_RUN_POLICY);
    expect(() => resolvePolicy({ budgetCapUsd: 10 })).toThrow(PolicyViolation);
    expect(() => resolvePolicy({ auto_checkout: true })).toThrow(PolicyViolation);
  });
});
