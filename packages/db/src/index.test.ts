import { describe, expect, it } from "vitest";
import { packageName } from "./index";

describe("@mp/db", () => {
  it("loads", () => {
    expect(packageName).toBe("@mp/db");
  });

  it("resolves its workspace dependencies", async () => {
    await expect(import("@mp/core")).resolves.toBeDefined();
  });
});
