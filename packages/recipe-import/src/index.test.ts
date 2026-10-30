import { describe, expect, it } from "vitest";
import { packageName } from "./index";

describe("@mp/recipe-import", () => {
  it("loads", () => {
    expect(packageName).toBe("@mp/recipe-import");
  });

  it("resolves its workspace dependencies", async () => {
    await expect(import("@mp/core")).resolves.toBeDefined();
  });
});
