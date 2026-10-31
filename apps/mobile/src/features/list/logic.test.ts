import type { GroceryListItem } from "@mp/core";
import { describe, expect, it } from "vitest";
import {
  amountLabel,
  attentionNote,
  contributionRows,
  moveSection,
  needSummary,
  parseQuantityInput,
  parseUnitInput,
  progressOf,
  quantityInputText,
  roundingSentence,
  rowAccessibilityLabel,
  sectionsToShow,
  splitItems,
  syncNote,
} from "./logic";

const NOW = "2026-11-01T18:00:00.000Z";
const ENTRY = "e0000000-0000-4000-8000-000000000001";

function item(n: number, overrides: Partial<GroceryListItem> = {}): GroceryListItem {
  return {
    id: `ea100000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    list_id: "1a000000-0000-4000-8000-0000000000a1",
    household_id: "0a000000-0000-4000-8000-00000000000a",
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

describe("splitItems", () => {
  it("separates what to buy from what the pantry covers and what a person removed", () => {
    const split = splitItems([
      item(1),
      item(2, { excluded_reason: "pantry" }),
      item(3, { excluded_reason: "manual" }),
      item(4),
    ]);
    expect(split.toBuy.map((i) => i.position)).toEqual([1, 4]);
    expect(split.haveAlready.map((i) => i.position)).toEqual([2]);
    expect(split.removed.map((i) => i.position)).toEqual([3]);
  });
});

describe("sectionsToShow", () => {
  const items = [
    item(1, { section: "dairy", display_name: "Milk" }),
    item(2, { section: "produce", display_name: "Kale", checked: true }),
    item(3, { section: "produce", display_name: "Leeks" }),
    item(4, { section: "meat", display_name: "Beef" }),
    item(5, { section: "produce", display_name: "Apples" }),
  ];

  it("groups in store order and puts checked items after the ones still to get", () => {
    const groups = sectionsToShow(items, null);
    expect(groups.map((g) => g.section)).toEqual(["produce", "meat", "dairy"]);
    expect(groups[0]?.items.map((i) => i.display_name)).toEqual(["Leeks", "Apples", "Kale"]);
  });

  it("follows the household's own order", () => {
    expect(sectionsToShow(items, ["dairy", "meat"]).map((g) => g.section)).toEqual([
      "dairy",
      "meat",
      "produce",
    ]);
  });

  it("can leave checked items out, and drops a section that empties", () => {
    const only = sectionsToShow(
      [item(1, { checked: true, section: "dairy" }), ...items.slice(2)],
      null,
      {
        hideChecked: true,
      },
    );
    expect(only.map((g) => g.section)).toEqual(["produce", "meat"]);
    expect(only[0]?.items.map((i) => i.display_name)).toEqual(["Leeks", "Apples"]);
  });

  it("does not change the list it was given", () => {
    const copy = [...items];
    sectionsToShow(items, null, { hideChecked: true });
    expect(items).toEqual(copy);
  });
});

describe("progressOf", () => {
  it("counts checked items, and is zero for an empty list", () => {
    expect(progressOf([])).toEqual({ done: 0, total: 0, fraction: 0 });
    expect(
      progressOf([item(1, { checked: true }), item(2), item(3, { checked: true }), item(4)]),
    ).toEqual({
      done: 2,
      total: 4,
      fraction: 0.5,
    });
  });
});

describe("words", () => {
  it("writes an amount the way a list reads", () => {
    expect(amountLabel({ qty: 1.5, unit: "cup" })).toBe("1½ cups");
    expect(amountLabel({ qty: 3, unit: "each" })).toBe("3");
    expect(amountLabel({ qty: 2, unit: "head" })).toBe("2 heads");
    expect(amountLabel({ qty: null, unit: null })).toBe("");
  });

  it("names a row for a screen reader", () => {
    expect(rowAccessibilityLabel(item(1, { display_name: "Garlic", qty: 2, unit: "head" }))).toBe(
      "Garlic, 2 heads",
    );
    expect(
      rowAccessibilityLabel(item(1, { display_name: "Salt", qty: null, needs_attention: true })),
    ).toBe("Salt, needs a look");
  });

  it("explains why an item needs a look, in words that fit the reason", () => {
    expect(attentionNote(item(1))).toBeNull();
    const reasons = ["unparsed", "mixed_units", "unknown_unit", null] as const;
    const notes = reasons.map((attention) =>
      attentionNote(item(1, { needs_attention: true, detail: { contributions: [], attention } })),
    );
    expect(new Set(notes).size).toBe(4);
    for (const note of notes) expect(note).toBeTruthy();
    expect(notes[0]).toContain("match this line");
    expect(notes[1]).toContain("cannot be added together");
  });

  it("summarizes the need", () => {
    expect(needSummary(item(1, { qty: 2, unit: "head" }))).toBe("You need 2 heads");
    expect(needSummary(item(1, { qty: null }))).toBe("No amount: buy some");
    expect(needSummary(item(1, { qty: 2, is_manual: true }))).toBe("You added this: 2");
    expect(needSummary(item(1, { qty: null, is_manual: true }))).toBe("You added this item.");
  });

  it("says how many changes wait to sync", () => {
    expect(syncNote(0)).toBeNull();
    expect(syncNote(1)).toBe("1 change saved on this device, waiting to sync.");
    expect(syncNote(10)).toBe("10 changes saved on this device, waiting to sync.");
  });
});

describe("the Why this amount sheet (acceptance criterion 5)", () => {
  const garlic = item(1, {
    display_name: "Garlic",
    qty: 2,
    unit: "head",
    detail: {
      contributions: [
        {
          entryId: ENTRY,
          recipeTitle: "Garlic Bread",
          servings: 4,
          recipeServings: 4,
          qty: 2,
          unit: "clove",
          rawTexts: ["2 cloves garlic, minced"],
        },
        {
          entryId: "e0000000-0000-4000-8000-000000000002",
          recipeTitle: "Roasted Garlic Soup",
          servings: 6,
          recipeServings: 4,
          qty: 15,
          unit: "clove",
          rawTexts: ["1 head garlic"],
          note: "Scaled from 4 servings.",
        },
        {
          entryId: "e0000000-0000-4000-8000-000000000003",
          recipeTitle: "Garnish",
          servings: 1,
          recipeServings: null,
          qty: null,
          unit: null,
          rawTexts: ["garlic, to taste"],
          optional: true,
        },
      ],
      rounding: {
        from: 17,
        fromUnit: "clove",
        to: 2,
        toUnit: "head",
        rule: "round up to whole heads",
      },
    },
  });

  it("lists every contributing recipe with its servings and converted quantity", () => {
    const rows = contributionRows(garlic);
    expect(rows.map((r) => r.recipe)).toEqual(["Garlic Bread", "Roasted Garlic Soup", "Garnish"]);
    expect(rows[0]).toMatchObject({
      servings: "4 servings",
      amount: "2 cloves",
      lines: ["2 cloves garlic, minced"],
    });
    expect(rows[1]).toMatchObject({
      servings: "6 servings (the recipe makes 4)",
      amount: "15 cloves",
      note: "Scaled from 4 servings.",
    });
    expect(rows[2]).toMatchObject({ amount: "No amount", optional: true });
    expect(new Set(rows.map((r) => r.key)).size).toBe(3);
  });

  it("states the rounding step when one was applied, and nothing when not", () => {
    expect(roundingSentence(garlic)).toBe("Added up: 17 cloves. Round up to whole heads: 2 heads.");
    expect(roundingSentence(item(2))).toBeNull();
  });

  it("says 1 serving, not 1 servings", () => {
    const one = item(3, {
      detail: {
        contributions: [
          {
            entryId: ENTRY,
            recipeTitle: "Solo",
            servings: 1,
            recipeServings: 1,
            qty: 1,
            unit: "each",
            rawTexts: ["1 egg"],
          },
        ],
      },
    });
    expect(contributionRows(one)[0]?.servings).toBe("1 serving");
  });
});

describe("parseQuantityInput", () => {
  it.each([
    ["2", 2],
    ["1.5", 1.5],
    [".5", 0.5],
    ["1/2", 0.5],
    ["1 1/2", 1.5],
    ["½", 0.5],
    ["1½", 1.5],
    ["2 ¾", 2.75],
    ["  3  ", 3],
  ])("reads %j as %s", (text, value) => {
    expect(parseQuantityInput(text)).toBeCloseTo(value, 6);
  });

  it("reads nothing as no amount", () => {
    expect(parseQuantityInput("")).toBeNull();
    expect(parseQuantityInput("   ")).toBeNull();
  });

  it.each(["0", "-1", "abc", "1/0", "1 2", "2 cups", "1e3", "99999999"])("refuses %j", (text) => {
    expect(parseQuantityInput(text)).toBe("invalid");
  });

  it("writes an amount back for the field", () => {
    expect(quantityInputText(null)).toBe("");
    expect(quantityInputText(1.5)).toBe("1.5");
    expect(quantityInputText(2)).toBe("2");
    expect(quantityInputText(1 / 3)).toBe("0.333");
  });
});

describe("parseUnitInput", () => {
  it("accepts words and refuses digits and symbols", () => {
    expect(parseUnitInput("")).toBeNull();
    expect(parseUnitInput(" lb ")).toBe("lb");
    expect(parseUnitInput("fl oz")).toBe("fl oz");
    expect(parseUnitInput("3 cups")).toBe("invalid");
    expect(parseUnitInput("cups!")).toBe("invalid");
    expect(parseUnitInput("x".repeat(41))).toBe("invalid");
  });
});

describe("moveSection", () => {
  const order = ["produce", "meat", "dairy"];

  it("moves a section one place and leaves the rest in order", () => {
    expect(moveSection(order, "meat", -1)).toEqual(["meat", "produce", "dairy"]);
    expect(moveSection(order, "meat", 1)).toEqual(["produce", "dairy", "meat"]);
  });

  it("does nothing past either end or for an unknown section, and never changes its input", () => {
    expect(moveSection(order, "produce", -1)).toEqual(order);
    expect(moveSection(order, "dairy", 1)).toEqual(order);
    expect(moveSection(order, "deli", 1)).toEqual(order);
    expect(order).toEqual(["produce", "meat", "dairy"]);
  });
});
