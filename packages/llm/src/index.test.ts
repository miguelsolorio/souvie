import { describe, expect, it } from "vitest";
import { packageName } from "./index";

describe("@mp/llm", () => {
  it("loads", () => {
    expect(packageName).toBe("@mp/llm");
  });

  it("resolves its workspace dependencies", async () => {
    await expect(import("@mp/core")).resolves.toBeDefined();
  });
});
