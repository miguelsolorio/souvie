import type { GroceryListItem, SectionGroup } from "@mp/core";
import { describe, expect, it } from "vitest";
import {
  PANE_ALL,
  PANE_HAVE,
  PANE_REMOVED,
  paneAccessibilityLabel,
  paneEntries,
  resolvePane,
  sectionOfPane,
  sectionPaneKey,
} from "./panes";

function item(id: string, section: string, checked = false): GroceryListItem {
  return { id, section, checked } as GroceryListItem;
}

const groups: SectionGroup<GroceryListItem>[] = [
  {
    section: "produce",
    label: "Produce",
    items: [item("a", "produce"), item("b", "produce", true), item("c", "produce")],
  },
  { section: "dairy", label: "Dairy", items: [item("d", "dairy", true)] },
];

describe("paneEntries", () => {
  it("starts with all items, then one entry per section in the order given", () => {
    const entries = paneEntries(groups, 0, 0);
    expect(entries.map((entry) => entry.key)).toEqual([
      PANE_ALL,
      sectionPaneKey("produce"),
      sectionPaneKey("dairy"),
    ]);
    expect(entries.map((entry) => entry.label)).toEqual(["All items", "Produce", "Dairy"]);
  });

  it("counts what is left to get and what is on the list", () => {
    const [all, produce, dairy] = paneEntries(groups, 0, 0);
    expect(all).toMatchObject({ remaining: 2, total: 4 });
    expect(produce).toMatchObject({ remaining: 2, total: 3 });
    expect(dairy).toMatchObject({ remaining: 0, total: 1 });
  });

  it("adds Already have and Removed only when they hold something", () => {
    expect(paneEntries(groups, 0, 0).map((entry) => entry.key)).not.toContain(PANE_HAVE);
    const entries = paneEntries(groups, 3, 1);
    expect(entries.map((entry) => entry.key).slice(-2)).toEqual([PANE_HAVE, PANE_REMOVED]);
    expect(entries.at(-2)).toMatchObject({ label: "Already have", total: 3 });
  });

  it("is just All items for an empty list", () => {
    expect(paneEntries([], 0, 0)).toEqual([
      { key: PANE_ALL, label: "All items", remaining: 0, total: 0 },
    ]);
  });
});

describe("resolvePane", () => {
  const entries = paneEntries(groups, 0, 0);

  it("keeps a pane that exists", () => {
    expect(resolvePane(entries, sectionPaneKey("dairy"))).toBe(sectionPaneKey("dairy"));
  });

  it("falls back to all items when the pane has gone", () => {
    expect(resolvePane(entries, PANE_HAVE)).toBe(PANE_ALL);
    expect(resolvePane(entries, sectionPaneKey("bakery"))).toBe(PANE_ALL);
  });
});

describe("sectionOfPane", () => {
  it("reads the section back out of a section key", () => {
    expect(sectionOfPane(sectionPaneKey("produce"))).toBe("produce");
    expect(sectionOfPane(PANE_ALL)).toBeNull();
    expect(sectionOfPane(PANE_HAVE)).toBeNull();
    expect(sectionOfPane(PANE_REMOVED)).toBeNull();
  });
});

describe("paneAccessibilityLabel", () => {
  it("says how many are left in a section", () => {
    const [, produce] = paneEntries(groups, 0, 0);
    expect(produce && paneAccessibilityLabel(produce)).toBe("Produce, 2 of 3 left");
  });

  it("says how many items are in Already have", () => {
    const entries = paneEntries(groups, 1, 2);
    expect(paneAccessibilityLabel(entries.at(-2) as (typeof entries)[number])).toBe(
      "Already have, 1 item",
    );
    expect(paneAccessibilityLabel(entries.at(-1) as (typeof entries)[number])).toBe(
      "Removed, 2 items",
    );
  });
});
