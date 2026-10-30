import { describe, expect, it } from "vitest";

describe("@mp/core", () => {
  it("exports the WS03 contracts", async () => {
    const mod = await import("./index");
    for (const name of [
      "convert",
      "toPurchasable",
      "normalizeUnit",
      "UNIT_ALIASES",
      "IngredientSchema",
      "ParsedIngredientSchema",
    ]) {
      expect(mod).toHaveProperty(name);
    }
  });
});
