import type { MpClient } from "@mp/db";
import { isDisplayUnchanged } from "@mp/retailers/kroger/terms";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RetailerApiError, searchKrogerProducts } from "./api";
import {
  completeKrogerRedirect,
  KROGER_REDIRECT_URI,
  parseKrogerRedirect,
  redirectFromParams,
  rememberConnectChoice,
  resetKrogerRedirects,
} from "./oauth";

afterEach(() => resetKrogerRedirects());

const CONNECTION = {
  id: "c0000000-0000-4000-8000-000000000001",
  householdId: "0a000000-0000-4000-8000-00000000000a",
  userId: "a1111111-1111-4111-8111-111111111111",
  retailer: "kroger",
  status: "active",
  storeId: "70500999",
  storeName: "QFC Fixture Ridge",
  modality: "pickup",
  lastVerifiedAt: "2026-10-30T19:30:02.000Z",
};

function fakeClient(answer: unknown) {
  const invoke = vi.fn(async (_name: string, _opts: { body: Record<string, unknown> }) => ({
    data: answer,
    error: null,
  }));
  return { client: { functions: { invoke } } as unknown as MpClient, invoke };
}

describe("parseKrogerRedirect", () => {
  it("reads the code and the state from the registered redirect", () => {
    expect(KROGER_REDIRECT_URI).toBe("souvie://oauth/kroger");
    expect(parseKrogerRedirect("souvie://oauth/kroger?code=abc&state=v1.x%2By.z")).toEqual({
      kind: "code",
      code: "abc",
      state: "v1.x+y.z",
    });
  });

  it("reports a Kroger error, and refuses anything that is not our redirect", () => {
    expect(
      parseKrogerRedirect("souvie://oauth/kroger?error=access_denied&error_description=No+thanks"),
    ).toEqual({ kind: "error", error: "access_denied", description: "No thanks" });
    expect(parseKrogerRedirect("souvie://oauth/kroger?code=abc")).toEqual({ kind: "invalid" });
    expect(parseKrogerRedirect("https://evil.test/oauth/kroger?code=a&state=b")).toEqual({
      kind: "invalid",
    });
  });

  it("rebuilds the redirect from route params", () => {
    const url = redirectFromParams({ code: "a b", state: "s/1", other: "ignored" });
    expect(url).toBe("souvie://oauth/kroger?code=a%20b&state=s%2F1");
    expect(parseKrogerRedirect(url)).toEqual({ kind: "code", code: "a b", state: "s/1" });
  });
});

describe("completeKrogerRedirect", () => {
  it("spends a code once even when the auth session and the route both see it", async () => {
    const { client, invoke } = fakeClient({ ok: true, connection: CONNECTION });
    rememberConnectChoice({ id: "70500999", name: "QFC Fixture Ridge" }, "PICKUP");
    const url = "souvie://oauth/kroger?code=once&state=v1.a.b";
    const [a, b] = await Promise.all([
      completeKrogerRedirect(client, url),
      completeKrogerRedirect(client, url),
    ]);
    expect(a).toEqual(CONNECTION);
    expect(b).toBe(a);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[1].body).toEqual({
      action: "exchange",
      code: "once",
      state: "v1.a.b",
      storeId: "70500999",
      storeName: "QFC Fixture Ridge",
      modality: "PICKUP",
    });
  });

  it("turns a cancelled sign-in into a readable error without calling the server", async () => {
    const { client, invoke } = fakeClient(null);
    const err = await completeKrogerRedirect(
      client,
      "souvie://oauth/kroger?error=access_denied",
    ).catch((e) => e);
    expect(err).toBeInstanceOf(RetailerApiError);
    expect(err.message).toBe("Kroger sign-in was cancelled.");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("surfaces the function's error code and message", async () => {
    const { client } = fakeClient({
      ok: false,
      error: "invalid_state",
      message: "The Kroger sign-in expired or did not start here. Try connecting again.",
    });
    await expect(
      completeKrogerRedirect(client, "souvie://oauth/kroger?code=c&state=s"),
    ).rejects.toMatchObject({ code: "invalid_state" });
  });
});

describe("searchKrogerProducts", () => {
  it("records returned products with the terms guard until the set is released", async () => {
    const product = {
      id: "0009990001001",
      upc: "0009990001001",
      name: "Fixture Farms Boneless Skinless Chicken Thighs",
      brand: "Fixture Farms",
      size: "per lb",
      price: 5.99,
      promoPrice: 4.49,
      soldBy: "WEIGHT",
      stockLevel: "HIGH",
      fulfillment: { instore: true, curbside: true, delivery: true, shiptohome: false },
      allergens: [],
      mayContain: [],
      imageUrl: null,
      // No cache header: the record lives only as long as the results do.
      cacheUntil: "2026-10-30T19:28:41.000Z",
    };
    const { client } = fakeClient({ ok: true, products: [product] });
    const { products, returned } = await searchKrogerProducts(client, {
      householdId: CONNECTION.householdId,
      storeId: "70500999",
      q: "chicken thighs",
    });
    const [received] = products;
    if (!received) throw new Error("no product");
    expect(isDisplayUnchanged(received, { name: product.name, price: "$5.99" })).toBe(true);
    expect(isDisplayUnchanged({ ...received, name: "CHICKEN" })).toBe(false);
    returned.release();
    expect(isDisplayUnchanged(received)).toBe(false);
  });
});
