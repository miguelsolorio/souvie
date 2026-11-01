// WS08 criterion 5: the shared page skills over the captured test page and small hand-built trees.
import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/static-test-page.snapshot.json" with { type: "json" };
import {
  findByRole,
  findByText,
  findStepper,
  nearestButton,
  normalizeText,
  parsePrice,
} from "./skills.ts";
import { pathTo, type SnapshotNode, type SnapshotTree } from "./snapshot.ts";

const tree = fixture as SnapshotTree;

function node(
  id: string,
  role: string,
  name: string,
  children: SnapshotNode[] = [],
  extra: Partial<SnapshotNode> = {},
): SnapshotNode {
  return {
    id,
    role,
    name,
    bbox: [0, 0, 10, 10],
    ...(children.length ? { children } : {}),
    ...extra,
  };
}

function treeOf(root: SnapshotNode): SnapshotTree {
  return { url: "https://example.test/", title: "t", root, capturedAt: "2026-10-31T00:00:00.000Z" };
}

describe("parsePrice", () => {
  it("reads a plain shelf price", () => {
    expect(parsePrice("$4.99")).toEqual({ amount: 4.99 });
    expect(parsePrice("  $12  ")).toEqual({ amount: 12 });
    expect(parsePrice("$1,299.00")).toEqual({ amount: 1299 });
    expect(parsePrice("99¢")).toEqual({ amount: 0.99 });
  });

  it("reads a multi-buy as the per-item price and keeps the offer", () => {
    expect(parsePrice("2 for $5.00")).toEqual({ amount: 2.5, multi: { count: 2, total: 5 } });
    expect(parsePrice("2/$5")).toEqual({ amount: 2.5, multi: { count: 2, total: 5 } });
    expect(parsePrice("3 for $10")).toEqual({ amount: 3.33, multi: { count: 3, total: 10 } });
  });

  it("reads a unit price with its unit", () => {
    expect(parsePrice("$0.31/oz")).toEqual({ amount: 0.31, unit: "oz" });
    expect(parsePrice("$3.99 / lb")).toEqual({ amount: 3.99, unit: "lb" });
    expect(parsePrice("$0.05 per fl oz")).toEqual({ amount: 0.05, unit: "floz" });
  });

  it("returns the current price from sale text", () => {
    expect(parsePrice("Was $6.49 Now $4.99")).toEqual({ amount: 4.99 });
    expect(parsePrice("Reg. $6.49 $4.99")).toEqual({ amount: 4.99 });
    expect(parsePrice("Sale $3.00 Save $1.50")).toEqual({ amount: 3 });
    expect(parsePrice("$4.99 ($0.12/oz)")).toEqual({ amount: 4.99 });
  });

  it("returns null when there is no price", () => {
    expect(parsePrice("42 oz")).toBeNull();
    expect(parsePrice("")).toBeNull();
    expect(parsePrice(null)).toBeNull();
    expect(parsePrice("Add")).toBeNull();
  });

  it("reads every price on the test page", () => {
    const prices = findByRole(tree, "text")
      .map((n) => parsePrice(n.name))
      .filter((p) => p !== null);
    expect(prices).toContainEqual({ amount: 4.99 });
    expect(prices).toContainEqual({ amount: 2.5, multi: { count: 2, total: 5 } });
    expect(prices).toContainEqual({ amount: 0.31, unit: "oz" });
    expect(prices).toContainEqual({ amount: 0.99 });
  });
});

describe("nearestButton", () => {
  it("picks the Add button inside the same tile, not the neighbour's", () => {
    const tiles = findByRole(tree, "article");
    expect(tiles).toHaveLength(10);
    for (const tile of tiles) {
      const title = tile.children?.find((c) => c.role === "heading");
      if (!title) throw new Error("tile without a title");
      const add = nearestButton(tree, title.id, "Add");
      const own = tile.children?.find((c) => c.role === "button" && c.name === "Add");
      expect(add?.id).toBe(own?.id);
    }
  });

  it("works from a price node and from the tile itself", () => {
    const [price] = findByText(tree, "$0.31/oz");
    if (!price) throw new Error("no price");
    const add = nearestButton(tree, price.id, "Add");
    const tile = pathTo(tree, price.id).at(-2);
    expect(tile?.role).toBe("article");
    expect(add?.id).toBe(tile?.children?.find((c) => c.role === "button")?.id);
    expect(nearestButton(tree, tile?.id ?? "", "Add")?.id).toBe(add?.id);
  });

  it("prefers the closest button in document order at the same level", () => {
    const t = treeOf(
      node("root", "document", "", [
        node("row", "generic", "", [
          node("b1", "button", "Remove"),
          node("label", "text", "Oats"),
          node("b2", "button", "Add"),
          node("b3", "button", "Details"),
        ]),
      ]),
    );
    expect(nearestButton(t, "label")?.id).toBe("b1");
    expect(nearestButton(t, "label", "Add")?.id).toBe("b2");
    expect(nearestButton(t, "label", /details/i)?.id).toBe("b3");
    expect(nearestButton(t, "label", "Checkout")).toBeNull();
    expect(nearestButton(t, "missing")).toBeNull();
  });
});

describe("findStepper", () => {
  it("finds plus, minus and the count on the test page", () => {
    const [line] = findByText(tree, "Fixture Farms Rolled Oats").filter((n) => n.role === "text");
    if (!line) throw new Error("no cart line");
    const stepper = findStepper(tree, line.id);
    expect(stepper?.minus.name).toBe("Decrease quantity");
    expect(stepper?.plus.name).toBe("Increase quantity");
    expect(stepper?.count.name).toBe("1");
    expect(stepper?.quantity).toBe(1);
  });

  it("prefers a spinbutton for the count and reads symbol-only buttons", () => {
    const t = treeOf(
      node("root", "document", "", [
        node("g", "group", "Qty", [
          node("m", "button", "-"),
          node("c", "spinbutton", "Quantity", [], { value: "3" }),
          node("p", "button", "+"),
        ]),
      ]),
    );
    const stepper = findStepper(t, "g");
    expect(stepper?.minus.id).toBe("m");
    expect(stepper?.plus.id).toBe("p");
    expect(stepper?.count.id).toBe("c");
    expect(stepper?.quantity).toBe(3);
  });

  it("returns null when there is no stepper", () => {
    const [heading] = findByRole(tree, "heading", "Results");
    expect(findStepper(tree, heading?.id ?? "")).toBeNull();
  });
});

describe("findByRole and findByText", () => {
  it("match whole names for roles and contained text for text", () => {
    expect(findByRole(tree, "button", "add")).toHaveLength(10);
    expect(findByRole(tree, "button", "Ad")).toHaveLength(0);
    expect(findByRole(tree, "button", /^show a/i)).toHaveLength(1);
    expect(findByText(tree, "peanut butter").map((n) => n.role)).toEqual(["heading"]);
    expect(findByText(tree, "Cart: 0").map((n) => n.role)).toEqual(["status"]);
  });
});

describe("normalizeText", () => {
  it("collapses whitespace, strips invisible characters and straightens quotes", () => {
    const nbsp = String.fromCodePoint(0xa0);
    const zwsp = String.fromCodePoint(0x200b);
    const curly = `${String.fromCodePoint(0x201c)}oat${String.fromCodePoint(0x2019)}s${String.fromCodePoint(0x201d)}`;
    expect(normalizeText(`  Oat${nbsp}${nbsp}milk\n\t${zwsp}64 oz `)).toBe("Oat milk 64 oz");
    expect(normalizeText(curly)).toBe(`"oat's"`);
    expect(normalizeText(String.fromCodePoint(0xfb01))).toBe("fi");
    expect(normalizeText(undefined)).toBe("");
  });
});
