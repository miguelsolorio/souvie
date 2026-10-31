import { describe, expect, it } from "vitest";
import { DEFAULT_RUN_POLICY, RunPolicy } from "./run.ts";

describe("RunPolicy", () => {
  it("fills every default from an empty object", () => {
    expect(DEFAULT_RUN_POLICY).toEqual({
      budget_cap_usd: null,
      per_item_ceiling_usd: null,
      substitution: "same_brand",
      auto_checkout: false,
      auto_checkout_cap_usd: null,
      max_tool_calls: 200,
      max_wall_clock_seconds: 900,
    });
  });

  it("keeps a full policy as given", () => {
    const policy = {
      budget_cap_usd: 150,
      per_item_ceiling_usd: 25,
      substitution: "none",
      auto_checkout: true,
      auto_checkout_cap_usd: 120,
      max_tool_calls: 50,
      max_wall_clock_seconds: 300,
    };
    expect(RunPolicy.parse(policy)).toEqual(policy);
  });

  it("rejects camelCase keys, unknown keys, bad values and auto_checkout without a cap", () => {
    expect(RunPolicy.safeParse({ budgetCapUsd: 100 }).success).toBe(false);
    expect(RunPolicy.safeParse({ brand_filter: "any" }).success).toBe(false);
    expect(RunPolicy.safeParse({ budget_cap_usd: -1 }).success).toBe(false);
    expect(RunPolicy.safeParse({ substitution: "brand" }).success).toBe(false);
    expect(RunPolicy.safeParse({ max_tool_calls: 1.5 }).success).toBe(false);
    expect(RunPolicy.safeParse({ auto_checkout: true }).success).toBe(false);
    expect(RunPolicy.safeParse({ auto_checkout: true, auto_checkout_cap_usd: 150 }).success).toBe(
      true,
    );
  });
});
