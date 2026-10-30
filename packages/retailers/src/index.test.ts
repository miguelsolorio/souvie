import { describe, expect, it } from "vitest";
import { packageName } from "./index";

describe("@mp/retailers", () => {
  it("loads", () => {
    expect(packageName).toBe("@mp/retailers");
  });

  it("resolves its workspace dependencies", async () => {
    await expect(import("@mp/core")).resolves.toBeDefined();
  });

  it("exposes the MockRetailer stub at its fixed path", async () => {
    const { MockRetailer } = await import("./index");
    expect(new MockRetailer()).toBeInstanceOf(MockRetailer);
  });
});
