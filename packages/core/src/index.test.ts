import { describe, expect, it } from "vitest";

describe("@mp/core", () => {
  it("loads and exports nothing until the orchestrator adds the first contract", async () => {
    const mod = await import("./index");
    expect(Object.keys(mod)).toEqual([]);
  });
});
