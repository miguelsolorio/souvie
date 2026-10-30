import { describe, expect, it } from "vitest";
import { packageName } from "./index";

describe("@mp/ui", () => {
  it("loads", () => {
    expect(packageName).toBe("@mp/ui");
  });

  it("resolves its workspace dependencies", async () => {
    await expect(import("@mp/core")).resolves.toBeDefined();
  });
});
