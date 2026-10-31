import { type GroceryListItem, planFingerprint } from "@mp/core";
import { describe, expect, it } from "vitest";
import {
  fetchListItems,
  isListStale,
  ListError,
  listErrorMessage,
  manualItemRow,
  nextItemPosition,
  patchColumns,
  sortItems,
  toListError,
  withItemAdded,
  withItemChecked,
  withItemPatched,
  withoutItem,
} from "./lists";
import { fakeClient } from "./testing/fakeClient";

const USER = "a1111111-1111-4111-8111-111111111111";
const LIST = "1a000000-0000-4000-8000-0000000000a1";
const HOUSEHOLD = "0a000000-0000-4000-8000-00000000000a";
const NOW = "2026-11-01T18:00:00.000Z";

function item(n: number, overrides: Partial<GroceryListItem> = {}): GroceryListItem {
  return {
    id: `ea100000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    list_id: LIST,
    household_id: HOUSEHOLD,
    ingredient_id: null,
    display_name: `Item ${n}`,
    qty: 1,
    unit: null,
    source_entry_ids: [],
    section: "produce",
    checked: false,
    checked_by: null,
    checked_at: null,
    excluded_reason: null,
    needs_attention: false,
    is_manual: false,
    position: n,
    qualifiers: [],
    edited: false,
    detail: { contributions: [] },
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

describe("toListError", () => {
  it("calls a request with no response a network error", () => {
    expect(toListError({ message: "TypeError: Failed to fetch" }, 0).code).toBe("network");
    expect(toListError({ message: "Network request failed" }).code).toBe("network");
    expect(toListError({ message: "boom" }, 503).code).toBe("network");
  });

  it("reads the codes the triggers and constraints raise", () => {
    expect(toListError({ message: "list_not_found", code: "P0001" }, 400).code).toBe("not_found");
    expect(toListError({ message: "checked_by_mismatch", code: "42501" }, 403).code).toBe(
      "forbidden",
    );
    expect(toListError({ message: "permission denied", code: "42501" }, 403).code).toBe(
      "forbidden",
    );
    expect(toListError({ message: "x", code: "23503" }, 409).code).toBe("not_found");
    expect(toListError({ message: "x", code: "23505" }, 409).code).toBe("conflict");
    expect(toListError({ message: "x", code: "23514" }, 400).code).toBe("invalid");
    expect(toListError({ message: "x", code: "22P02" }, 400).code).toBe("invalid");
    expect(toListError({ message: "mystery", code: "XX000" }, 400).code).toBe("unknown");
  });

  it("words every code for a person", () => {
    for (const code of [
      "network",
      "forbidden",
      "not_found",
      "invalid",
      "no_plan",
      "conflict",
      "unknown",
    ] as const) {
      expect(listErrorMessage(new ListError(code)).length).toBeGreaterThan(10);
    }
    expect(listErrorMessage(new Error("raw internals"))).not.toContain("raw internals");
  });
});

describe("patchColumns", () => {
  it("marks an item edited when the amount, unit, or section changes", () => {
    expect(patchColumns({ qty: 3 })).toEqual({ qty: 3, edited: true });
    expect(patchColumns({ unit: "lb" })).toEqual({ unit: "lb", edited: true });
    expect(patchColumns({ section: "meat", qty: null })).toEqual({
      section: "meat",
      qty: null,
      edited: true,
    });
  });

  it("does not mark a removal as an edit of the amount", () => {
    expect(patchColumns({ excluded_reason: "manual" })).toEqual({ excluded_reason: "manual" });
    expect(patchColumns({ excluded_reason: null })).toEqual({ excluded_reason: null });
  });

  it("has no rename: a name is not part of an item patch, because a rebuild would overwrite it (F8)", () => {
    expect(patchColumns({ display_name: "Bananas" } as never)).toEqual({});
    expect(patchColumns({ qty: 2, display_name: "Bananas" } as never)).toEqual({
      qty: 2,
      edited: true,
    });
  });

  it("refuses values the database would", () => {
    expect(() => patchColumns({ qty: -1 })).toThrow();
    expect(() => patchColumns({ excluded_reason: "pantry" as never })).not.toThrow();
  });
});

describe("cache edits", () => {
  const items = [item(1), item(2), item(3)];

  it("sets a check state with who and when", () => {
    const next = withItemChecked(items, {
      itemId: items[1]?.id ?? "",
      checked: true,
      userId: USER,
      at: NOW,
    });
    expect(next[1]).toMatchObject({ checked: true, checked_by: USER, checked_at: NOW });
    expect(next[0]?.checked).toBe(false);
    expect(items[1]?.checked).toBe(false);
  });

  it("patches, adds in order, and removes", () => {
    const patched = withItemPatched(
      items,
      items[0]?.id ?? "",
      { qty: 5 },
      "2026-11-02T00:00:00.000Z",
    );
    expect(patched[0]).toMatchObject({
      qty: 5,
      edited: true,
      updated_at: "2026-11-02T00:00:00.000Z",
    });
    const added = withItemAdded(items, item(0));
    expect(added.map((i) => i.position)).toEqual([0, 1, 2, 3]);
    expect(
      withItemAdded(added, item(0, { display_name: "Renamed" })).filter((i) => i.position === 0),
    ).toHaveLength(1);
    expect(withoutItem(items, items[2]?.id ?? "").map((i) => i.position)).toEqual([1, 2]);
    expect(
      withItemChecked(undefined, { itemId: "x", checked: true, userId: USER, at: NOW }),
    ).toEqual([]);
  });

  it("orders by position, then creation, then id", () => {
    const sorted = sortItems([
      item(2),
      item(1, { position: 2, created_at: "2026-11-01T17:00:00.000Z" }),
      item(3, { position: 2, created_at: "2026-11-01T19:00:00.000Z" }),
    ]);
    expect(sorted.map((i) => i.display_name)).toEqual(["Item 1", "Item 2", "Item 3"]);
  });

  it("puts a new manual item at the end", () => {
    expect(nextItemPosition([])).toBe(0);
    expect(nextItemPosition(items)).toBe(4);
  });

  it("builds the row a manual item has before the server answers", () => {
    const row = manualItemRow({
      id: "ea100000-0000-4000-8000-0000000000aa",
      listId: LIST,
      householdId: HOUSEHOLD,
      item: { display_name: "Candles", qty: 1, unit: "box" },
      position: 9,
    });
    expect(row).toMatchObject({
      display_name: "Candles",
      qty: 1,
      unit: "box",
      section: "other",
      is_manual: true,
      checked: false,
      needs_attention: false,
      position: 9,
    });
  });
});

describe("isListStale (acceptance criterion 9)", () => {
  const entries = [
    { id: "e1", recipe_id: "r1", servings: 4, status: "planned" },
    { id: "e2", recipe_id: "r2", servings: 2, status: "planned" },
  ];
  const list = { plan_fingerprint: planFingerprint(entries) };

  it("is false for the plan the list was built from", () => {
    expect(isListStale(list, entries)).toBe(false);
    expect(isListStale(list, [...entries].reverse())).toBe(false);
  });

  it("is true once an entry is added, removed, swapped, rescaled or marked", () => {
    const [first, second] = entries as [(typeof entries)[0], (typeof entries)[0]];
    expect(
      isListStale(list, [
        ...entries,
        { id: "e3", recipe_id: "r3", servings: 4, status: "planned" },
      ]),
    ).toBe(true);
    expect(isListStale(list, [first])).toBe(true);
    expect(isListStale(list, [{ ...first, recipe_id: "r9" }, second])).toBe(true);
    expect(isListStale(list, [{ ...first, servings: 6 }, second])).toBe(true);
    expect(isListStale(list, [first, { ...second, status: "skipped" }])).toBe(true);
  });

  it("is never true for an ad-hoc list or before the list has loaded", () => {
    expect(isListStale({ plan_fingerprint: null }, entries)).toBe(false);
    expect(isListStale(null, entries)).toBe(false);
    expect(isListStale(undefined, entries)).toBe(false);
  });
});

describe("fetchListItems (F2)", () => {
  // What PostgREST returns for a manual item the client inserted: `detail` is the column default.
  const serverManual = {
    ...item(1),
    display_name: "Paper towels",
    is_manual: true,
    section: "household",
    detail: {},
  };

  it("gives a server row the shape the screens read, whatever the column holds", async () => {
    const { client, server } = fakeClient();
    server.tables.grocery_list_items = [
      serverManual,
      { ...item(2), detail: { contributions: [], rounding: null, attention: null } },
      { ...item(3), detail: null, qualifiers: null, source_entry_ids: null },
    ];
    const items = await fetchListItems(client, LIST);
    expect(items).toHaveLength(3);
    for (const row of items) {
      expect(row.detail.contributions).toEqual([]);
      expect(Array.isArray(row.qualifiers)).toBe(true);
      expect(Array.isArray(row.source_entry_ids)).toBe(true);
    }
    expect(items[0]?.display_name).toBe("Paper towels");
  });

  it("keeps the contributions of an automatic item", async () => {
    const { client, server } = fakeClient();
    const contribution = {
      entryId: "e0000000-0000-4000-8000-000000000001",
      recipeTitle: "Tacos",
      servings: 4,
      recipeServings: 4,
      qty: 2,
      unit: "can",
      rawTexts: ["2 cans black beans"],
    };
    server.tables.grocery_list_items = [{ ...item(1), detail: { contributions: [contribution] } }];
    const [row] = await fetchListItems(client, LIST);
    expect(row?.detail.contributions).toEqual([contribution]);
  });
});
