import { describe, expect, it } from "vitest";
import { ParsedIngredientSchema } from "./ingredient.ts";

const base = {
  rawText: "2 (14 oz) cans diced tomatoes",
  qty: 28,
  qtyMax: null,
  unit: "oz",
  ingredientId: null,
  ingredientName: "diced tomatoes",
  prepNote: null,
  optional: false,
  confidence: 0.95,
  stage: "grammar" as const,
};

describe("ParsedIngredient container fields (CCR5)", () => {
  it("keeps the container count and word beside the total contents", () => {
    const parsed = ParsedIngredientSchema.parse({ ...base, containerCount: 2, container: "can" });
    expect(parsed.qty).toBe(28);
    expect(parsed.unit).toBe("oz");
    expect(parsed.containerCount).toBe(2);
    expect(parsed.container).toBe("can");
  });

  it("is optional and nullable, so older parser output still parses", () => {
    expect(ParsedIngredientSchema.parse(base).containerCount).toBeUndefined();
    const nulls = ParsedIngredientSchema.parse({ ...base, containerCount: null, container: null });
    expect(nulls.containerCount).toBeNull();
    expect(nulls.container).toBeNull();
  });

  it("rejects a zero or fractional count and an empty container word", () => {
    expect(ParsedIngredientSchema.safeParse({ ...base, containerCount: 0 }).success).toBe(false);
    expect(ParsedIngredientSchema.safeParse({ ...base, containerCount: 1.5 }).success).toBe(false);
    expect(ParsedIngredientSchema.safeParse({ ...base, container: "" }).success).toBe(false);
  });
});
