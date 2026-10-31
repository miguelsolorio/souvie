import { describe, expect, it } from "vitest";
import { swapPatch } from "./swap";

const RECIPE = "aa000000-0000-4000-8000-000000000001";

describe("swapPatch", () => {
  it("replaces the recipe, resets the status, and never touches servings or notes", () => {
    const patch = swapPatch(RECIPE, "Fits a busy Tuesday");
    expect(patch).toEqual({ recipe_id: RECIPE, status: "planned", why: "Fits a busy Tuesday" });
    expect(patch).not.toHaveProperty("servings");
    expect(patch).not.toHaveProperty("notes");
  });

  it("clears the reason for a recipe a person picked", () => {
    expect(swapPatch(RECIPE).why).toBeNull();
    expect(swapPatch(RECIPE, null).why).toBeNull();
    expect(swapPatch(RECIPE, "   ").why).toBeNull();
  });

  it("trims the reason and holds it to the database's 200 characters", () => {
    expect(swapPatch(RECIPE, "  Uses the lemons  ").why).toBe("Uses the lemons");
    expect(swapPatch(RECIPE, "x".repeat(500)).why).toHaveLength(200);
  });
});
