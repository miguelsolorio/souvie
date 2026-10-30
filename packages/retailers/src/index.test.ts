import { describe, expect, it } from "vitest";
import * as contract from "./index";

describe("@mp/retailers", () => {
  it("loads", () => {
    expect(contract.packageName).toBe("@mp/retailers");
  });

  it("resolves its workspace dependencies", async () => {
    await expect(import("@mp/core")).resolves.toBeDefined();
  });

  it("keeps adapters out of the root entry so the app bundle never carries them", () => {
    expect(Object.keys(contract)).not.toContain("KrogerAdapter");
    expect(Object.keys(contract)).not.toContain("MockRetailer");
  });

  it("serves the mock and the Kroger adapter from their own entry points", async () => {
    const mock = await import("./mock/index.ts");
    const kroger = await import("./kroger/index.ts");
    expect(new mock.MockRetailer().capabilities.cartRead).toBe("api");
    expect(kroger.KrogerAdapter).toBeTypeOf("function");
  });

  it("lists the documented capabilities for every retailer", () => {
    expect(contract.RETAILER_CAPABILITIES.kroger).toEqual({
      search: "api",
      cartAdd: "api",
      cartRead: "none",
      slots: "handoff",
      checkout: "handoff",
      orders: "none",
    });
    expect(Object.values(contract.MOCK_CAPABILITIES).every((c) => c === "api")).toBe(true);
  });
});
