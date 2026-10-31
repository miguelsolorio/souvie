import { ALLERGENS, DIETS, ENFORCED_DIETS } from "@mp/core";
import { describe, expect, it } from "vitest";
import { ALLERGEN_LABEL, DIET_LABEL, DIET_NOTE, titleCase } from "./labels";

describe("onboarding labels", () => {
  it("has a label for every diet and allergen", () => {
    for (const diet of DIETS) expect(DIET_LABEL[diet], diet).toBeTruthy();
    for (const allergen of ALLERGENS) expect(ALLERGEN_LABEL[allergen], allergen).toBeTruthy();
    expect(Object.keys(DIET_LABEL)).toHaveLength(DIETS.length);
    expect(Object.keys(ALLERGEN_LABEL)).toHaveLength(ALLERGENS.length);
  });

  it("explains each diet the filters cannot enforce", () => {
    for (const diet of DIETS) {
      if (ENFORCED_DIETS.includes(diet) || diet === "omnivore") continue;
      expect(DIET_NOTE[diet], diet).toBeTruthy();
    }
  });

  it("has no em dashes in copy", () => {
    const all = [
      ...Object.values(DIET_LABEL),
      ...Object.values(DIET_NOTE),
      ...Object.values(ALLERGEN_LABEL),
    ];
    for (const text of all) expect(text).not.toContain("—");
  });

  it("title-cases cuisine names", () => {
    expect(titleCase("middle eastern")).toBe("Middle Eastern");
    expect(titleCase("thai")).toBe("Thai");
  });
});
