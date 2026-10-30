import { describe, expect, it } from "vitest";
import { packageName } from "./index.ts";

describe("@mp/llm", () => {
  it("loads", () => {
    expect(packageName).toBe("@mp/llm");
  });

  it("exports the WS02 surface", async () => {
    const mod = await import("./index.ts");
    for (const name of [
      "extract",
      "logAiRun",
      "createDailyCapGuard",
      "estimateCostUsd",
      "createAnthropicClient",
      "definePrompt",
      "RECIPE_EXTRACT_V1",
      "MODELS",
      "LlmError",
    ]) {
      expect(mod, name).toHaveProperty(name);
    }
  });

  it("resolves its workspace dependencies", async () => {
    await expect(import("@mp/core")).resolves.toBeDefined();
  });
});
