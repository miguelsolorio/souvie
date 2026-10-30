import { describe, expect, it } from "vitest";
import { packageName } from "./index";

describe("@mp/ingredient-parser", () => {
  it("loads", () => {
    expect(packageName).toBe("@mp/ingredient-parser");
  });

  it("resolves its workspace dependencies", async () => {
    await expect(import("@mp/core")).resolves.toBeDefined();
  });
});
