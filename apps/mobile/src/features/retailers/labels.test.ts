import { describe, expect, it } from "vitest";
import { allergenLines, approvedForLabel, STOCK_LABEL } from "./labels";

describe("allergenLines", () => {
  it("keeps contains and may contain on separate lines", () => {
    expect(
      allergenLines({
        allergens: ["Tree Nuts", "Peanuts", "Milk"],
        mayContain: ["Peanuts"],
        undeclared: [],
      }),
    ).toEqual(["Contains: Tree Nuts, Milk", "May contain: Peanuts"]);
  });

  it("never prints a may-contain allergen as Contains", () => {
    const lines = allergenLines({ allergens: ["Sesame"], mayContain: ["Sesame"], undeclared: [] });
    expect(lines).toEqual(["May contain: Sesame"]);
    expect(lines.join(" ")).not.toContain("Contains");
  });

  it("prints an undeclared allergen as Not declared, never as Contains", () => {
    const lines = allergenLines({
      allergens: ["Wheat", "Sesame"],
      mayContain: [],
      undeclared: ["Sesame"],
    });
    expect(lines).toEqual(["Contains: Wheat", "Not declared: Sesame"]);
  });

  it("shows nothing when nothing is declared", () => {
    expect(allergenLines({ allergens: [], mayContain: [], undeclared: [] })).toEqual([]);
  });
});

describe("stock and fulfillment wording", () => {
  it("never says an item is in stock", () => {
    for (const label of Object.values(STOCK_LABEL)) {
      expect(label.toLowerCase()).not.toContain("in stock");
      expect(label.startsWith("Stock level:")).toBe(true);
    }
    expect(STOCK_LABEL.HIGH).toBe("Stock level: high (confirmed at checkout)");
  });

  it("says approved for, not available", () => {
    expect(
      approvedForLabel({ instore: true, curbside: true, delivery: false, shiptohome: false }),
    ).toBe("Approved for pickup, in store");
  });
});
