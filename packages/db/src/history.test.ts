import type { MostBoughtRow } from "@mp/core";
import { describe, expect, it } from "vitest";
import {
  fetchMealsCooked,
  fetchMostBought,
  fetchSpendWeekly,
  historyFromWeek,
  historyRootKey,
  mealsCookedKey,
  mostBoughtKey,
  pinKey,
  setPinned,
  spendWeeklyKey,
  withPinned,
} from "./history";
import { eqFilters, opArgs, recordingClient } from "./testing/recordingClient";

const HOUSEHOLD = "0a000000-0000-4000-8000-00000000000a";
const ONION = "12000000-0000-4000-8000-000000000001";
const MILK = "12000000-0000-4000-8000-000000000002";

const row = (over: Partial<MostBoughtRow> = {}): MostBoughtRow => ({
  household_id: HOUSEHOLD,
  retailer: "kroger",
  store_id: "MOCK0001",
  store_name: "Mock QFC Duvall",
  ingredient_id: ONION,
  product_id: "P-ONION",
  upc: "0099010000004",
  product_name: "Harbor Fields Yellow Onions",
  size: "3 lb bag",
  times_bought: 2,
  units_bought: 3,
  last_bought_at: "2026-11-09T09:00:00+00:00",
  pinned: false,
  ...over,
});

describe("historyFromWeek", () => {
  it("is the Monday of the oldest week in the window", () => {
    expect(historyFromWeek("2026-11-05", 1)).toBe("2026-11-02");
    expect(historyFromWeek("2026-11-05", 3)).toBe("2026-10-19");
    expect(historyFromWeek("2026-11-05")).toBe("2026-08-17");
  });

  it("falls back to this week for a window of nothing", () => {
    expect(historyFromWeek("2026-11-05", 0)).toBe("2026-11-02");
  });
});

describe("query keys", () => {
  it("put the household first, so a household's history never shares an entry", () => {
    expect(historyRootKey("h1")).toEqual(["history", "h1"]);
    for (const key of [mealsCookedKey("h1", "2026-08-17"), spendWeeklyKey("h1", "2026-08-17")]) {
      expect(key.slice(0, 2)).toEqual(["history", "h1"]);
    }
    expect(mostBoughtKey("h1").slice(0, 2)).toEqual(["history", "h1"]);
    expect(mostBoughtKey("h1")).not.toEqual(mostBoughtKey("h2"));
  });
});

describe("fetchMealsCooked", () => {
  it("reads the household's cooked weeks from the given Monday, newest first", async () => {
    const { client, calls } = recordingClient([
      {
        data: [
          {
            household_id: HOUSEHOLD,
            week_start: "2026-11-02",
            cooked_count: 3,
            entries: [
              {
                id: "22000000-0000-4000-8000-000000000001",
                date: "2026-11-03",
                slot: "dinner",
                recipe_id: "42000000-0000-4000-8000-0000000000a1",
                title: "Lemon chicken",
              },
            ],
          },
        ],
      },
    ]);
    const weeks = await fetchMealsCooked(client, HOUSEHOLD, "2026-08-17");
    expect(weeks[0]?.cooked_count).toBe(3);
    expect(weeks[0]?.entries[0]?.title).toBe("Lemon chicken");
    expect(calls[0]?.target).toBe("v_meals_cooked_weekly");
    expect(eqFilters(calls[0])).toEqual([["household_id", HOUSEHOLD]]);
    expect(opArgs(calls[0], "gte")).toEqual(["week_start", "2026-08-17"]);
    expect(opArgs(calls[0], "order")).toEqual(["week_start", { ascending: false }]);
  });

  it("throws on a row that does not match, and on a failed request", async () => {
    const bad = recordingClient([{ data: [{ household_id: HOUSEHOLD, week_start: "nope" }] }]);
    await expect(fetchMealsCooked(bad.client, HOUSEHOLD, "2026-08-17")).rejects.toThrow();
    const failed = recordingClient([{ error: { message: "x", code: "XX000" }, status: 500 }]);
    await expect(fetchMealsCooked(failed.client, HOUSEHOLD, "2026-08-17")).rejects.toThrow();
  });
});

describe("fetchSpendWeekly", () => {
  it("reads totals per week and store, newest week first", async () => {
    const { client, calls } = recordingClient([
      {
        data: [
          {
            household_id: HOUSEHOLD,
            week_start: "2026-11-02",
            retailer: "kroger",
            store_name: "Mock QFC Redmond",
            total_usd: "65.50",
            order_count: 2,
          },
          {
            household_id: HOUSEHOLD,
            week_start: "2026-11-02",
            retailer: "kroger",
            store_name: null,
            total_usd: 100,
            order_count: 1,
          },
        ],
      },
    ]);
    const rows = await fetchSpendWeekly(client, HOUSEHOLD, "2026-08-17");
    expect(rows.map((r) => r.total_usd)).toEqual([65.5, 100]);
    expect(calls[0]?.target).toBe("v_spend_weekly_by_store");
    expect(opArgs(calls[0], "gte")).toEqual(["week_start", "2026-08-17"]);
    expect(calls[0]?.ops.filter(([name]) => name === "order").map(([, c]) => c)).toEqual([
      "week_start",
      "total_usd",
    ]);
  });
});

describe("fetchMostBought", () => {
  it("reads the top twenty by times bought, then most recent", async () => {
    const { client, calls } = recordingClient([
      {
        data: [
          {
            household_id: HOUSEHOLD,
            retailer: "kroger",
            store_id: "MOCK0001",
            store_name: null,
            ingredient_id: ONION,
            product_id: "P-ONION",
            upc: null,
            product_name: "Harbor Fields Yellow Onions",
            size: null,
            times_bought: 2,
            units_bought: "3",
            last_bought_at: "2026-11-09T09:00:00+00:00",
            pinned: true,
          },
        ],
      },
    ]);
    const rows = await fetchMostBought(client, HOUSEHOLD);
    expect(rows[0]).toMatchObject({ product_id: "P-ONION", units_bought: 3, pinned: true });
    expect(calls[0]?.target).toBe("v_most_bought_products");
    expect(calls[0]?.ops.filter(([name]) => name === "order").map(([, c]) => c)).toEqual([
      "times_bought",
      "last_bought_at",
    ]);
    expect(opArgs(calls[0], "limit")).toEqual([20]);
    // Names and sizes only. No amounts are read.
    expect(String(opArgs(calls[0], "select")?.[0])).not.toMatch(/price|total/);
  });
});

describe("pinKey", () => {
  it("is the key product_matches pins by", () => {
    expect(pinKey(row())).toEqual({
      household_id: HOUSEHOLD,
      retailer: "kroger",
      store_id: "MOCK0001",
      ingredient_id: ONION,
      product_id: "P-ONION",
    });
  });

  it("is null for a product with no ingredient or no store, which cannot be pinned", () => {
    expect(pinKey(row({ ingredient_id: null }))).toBeNull();
    expect(pinKey(row({ store_id: null }))).toBeNull();
  });
});

describe("withPinned", () => {
  it("changes the one product matching the whole key and leaves the rest", () => {
    const onion = row();
    const milkHere = row({ ingredient_id: MILK, product_id: "P-MILK" });
    const milkElsewhere = row({ ingredient_id: MILK, product_id: "P-MILK", store_id: "MOCK0003" });
    const next = withPinned([onion, milkHere, milkElsewhere], milkHere, true);
    expect(next.map((r) => r.pinned)).toEqual([false, true, false]);
    expect(onion.pinned).toBe(false);
  });
});

describe("setPinned", () => {
  it("updates the existing match with chosen_by user, on the whole key", async () => {
    const { client, calls } = recordingClient([{ data: [{ id: "m1" }] }]);
    await setPinned(client, row(), true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.target).toBe("product_matches");
    expect(opArgs(calls[0], "update")).toEqual([{ pinned: true, chosen_by: "user" }]);
    expect(eqFilters(calls[0])).toEqual([
      ["household_id", HOUSEHOLD],
      ["retailer", "kroger"],
      ["store_id", "MOCK0001"],
      ["ingredient_id", ONION],
      ["product_id", "P-ONION"],
    ]);
  });

  it("unpins with the same update, and does nothing more when no match is left", async () => {
    const { client, calls } = recordingClient([{ data: [] }]);
    await setPinned(client, row({ pinned: true }), false);
    expect(opArgs(calls[0], "update")).toEqual([{ pinned: false, chosen_by: "user" }]);
    expect(calls).toHaveLength(1);
  });

  it("writes the match again from the order's own name and ids when pinning finds none", async () => {
    const { client, calls } = recordingClient([{ data: [] }, { data: null }]);
    await setPinned(client, row(), true);
    expect(calls.map((call) => call.ops[0]?.[0])).toEqual(["update", "insert"]);
    expect(opArgs(calls[1], "insert")).toEqual([
      {
        household_id: HOUSEHOLD,
        retailer: "kroger",
        store_id: "MOCK0001",
        ingredient_id: ONION,
        product_id: "P-ONION",
        upc: "0099010000004",
        product_name: "Harbor Fields Yellow Onions",
        size: "3 lb bag",
        chosen_by: "user",
        pinned: true,
      },
    ]);
  });

  it("updates again when someone else wrote the match between our update and our insert", async () => {
    const { client, calls } = recordingClient([
      { data: [] },
      { error: { message: "duplicate key", code: "23505" }, status: 409 },
      { data: [{ id: "m1" }] },
    ]);
    await setPinned(client, row(), true);
    expect(calls.map((call) => call.ops[0]?.[0])).toEqual(["update", "insert", "update"]);
  });

  it("refuses a product with no ingredient or no name to remember", async () => {
    const { client, calls } = recordingClient([]);
    await expect(setPinned(client, row({ ingredient_id: null }), true)).rejects.toMatchObject({
      code: "invalid",
    });
    expect(calls).toHaveLength(0);
    const noName = recordingClient([{ data: [] }]);
    await expect(setPinned(noName.client, row({ product_name: null }), true)).rejects.toMatchObject(
      {
        code: "invalid",
      },
    );
  });

  it("raises a refused write as an order error", async () => {
    const { client } = recordingClient([
      { error: { message: "permission denied", code: "42501" }, status: 403 },
    ]);
    await expect(setPinned(client, row(), true)).rejects.toMatchObject({ code: "forbidden" });
  });
});
