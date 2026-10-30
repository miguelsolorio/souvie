import { describe, expect, it } from "vitest";
import { packageName } from "./index";

describe("@mp/agent", () => {
  it("loads", () => {
    expect(packageName).toBe("@mp/agent");
  });

  it("resolves its workspace dependencies", async () => {
    await expect(import("@mp/core")).resolves.toBeDefined();
    await expect(import("@mp/llm")).resolves.toBeDefined();
    await expect(import("@mp/retailers")).resolves.toBeDefined();
  });
});
