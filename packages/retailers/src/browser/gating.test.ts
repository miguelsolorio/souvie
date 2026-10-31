// WS08 criterion 7: the Tier 3 gate, and the registry hook it plugs into (orchestrator correction 5).
import { afterEach, describe, expect, it, vi } from "vitest";
import { RetailerNotSupportedError } from "../errors.ts";
import { MockRetailer } from "../mock/MockRetailer.ts";
import { AdapterRegistry, defaultRegistry, getAdapter, registerAdapter } from "../registry.ts";
import {
  configureTier3Gate,
  createTier3Gate,
  decideTier3,
  getGatedAdapter,
  installTier3Gate,
  isTier3Allowed,
  TIER3_RETAILER_IDS,
  type Tier3Consent,
  Tier3GateError,
  type Tier3GateReason,
  tier3Gate,
} from "./gating.ts";

const HOUSEHOLD = "0a000000-0000-4000-8000-00000000000a";
const VERSION = "2026-10-31";

function consent(retailers: string[], copyVersion = VERSION): Tier3Consent {
  return {
    accepted_at: "2026-10-31T17:00:00.000+00:00",
    by_user_id: "a1111111-1111-4111-8111-111111111111",
    retailers,
    copy_version: copyVersion,
  };
}

function gateWith(opts: { flag?: boolean | Error; consent?: Tier3Consent | null }) {
  const isFlagOn = vi.fn(async () => {
    if (opts.flag instanceof Error) throw opts.flag;
    return opts.flag ?? true;
  });
  const readConsent = vi.fn(async () => opts.consent ?? null);
  return {
    gate: createTier3Gate({ isFlagOn, readConsent, consentVersion: VERSION }),
    isFlagOn,
    readConsent,
  };
}

async function reasonOf(promise: Promise<unknown>): Promise<Tier3GateReason | "resolved"> {
  try {
    await promise;
    return "resolved";
  } catch (err) {
    expect(err).toBeInstanceOf(Tier3GateError);
    expect(err).toBeInstanceOf(RetailerNotSupportedError);
    return (err as Tier3GateError).reason;
  }
}

afterEach(() => {
  defaultRegistry.clear();
  configureTier3Gate(null);
});

describe("tier3Gate", () => {
  it("flag off: RetailerNotSupportedError with flag_off, without reading consent", async () => {
    const { gate, readConsent } = gateWith({ flag: false, consent: consent(["safeway"]) });
    expect(await reasonOf(gate.tier3Gate(HOUSEHOLD, "safeway"))).toBe("flag_off");
    expect(readConsent).not.toHaveBeenCalled();
  });

  it("flag on, no consent: no_consent", async () => {
    const { gate } = gateWith({ consent: null });
    expect(await reasonOf(gate.tier3Gate(HOUSEHOLD, "safeway"))).toBe("no_consent");
  });

  it("flag on, consent for costco only, asking for safeway: no_consent", async () => {
    const { gate } = gateWith({ consent: consent(["costco"]) });
    expect(await reasonOf(gate.tier3Gate(HOUSEHOLD, "safeway"))).toBe("no_consent");
    expect(await reasonOf(gate.tier3Gate(HOUSEHOLD, "costco"))).toBe("resolved");
  });

  it("consent at an older copy_version: stale_consent", async () => {
    const { gate } = gateWith({ consent: consent(["safeway", "costco"], "2026-09-01") });
    expect(await reasonOf(gate.tier3Gate(HOUSEHOLD, "safeway"))).toBe("stale_consent");
  });

  it("flag on and matching consent: resolves", async () => {
    const { gate, isFlagOn, readConsent } = gateWith({ consent: consent(["safeway"]) });
    expect(await reasonOf(gate.tier3Gate(HOUSEHOLD, "safeway"))).toBe("resolved");
    expect(isFlagOn).toHaveBeenCalledWith("safeway");
    expect(readConsent).toHaveBeenCalledWith(HOUSEHOLD);
    expect(await gate.isTier3Allowed(HOUSEHOLD, "safeway")).toEqual({ ok: true });
  });

  it("a flag that cannot be read counts as on (it is a kill switch, not an opt-in)", async () => {
    const { gate } = gateWith({
      flag: new Error("posthog unreachable"),
      consent: consent(["safeway"]),
    });
    expect(await reasonOf(gate.tier3Gate(HOUSEHOLD, "safeway"))).toBe("resolved");
  });

  it("refuses retailers that are not Tier 3", async () => {
    const { gate } = gateWith({ consent: consent(["safeway"]) });
    await expect(gate.tier3Gate(HOUSEHOLD, "kroger")).rejects.toBeInstanceOf(
      RetailerNotSupportedError,
    );
  });

  it("the module-level functions use the configured gate", async () => {
    await expect(tier3Gate(HOUSEHOLD, "safeway")).rejects.toBeInstanceOf(RetailerNotSupportedError);
    configureTier3Gate({
      isFlagOn: async () => true,
      readConsent: async () => consent(["safeway"]),
      consentVersion: VERSION,
    });
    await expect(tier3Gate(HOUSEHOLD, "safeway")).resolves.toBeUndefined();
    expect(await isTier3Allowed(HOUSEHOLD, "costco")).toEqual({ ok: false, reason: "no_consent" });
  });

  it("decideTier3 is the pure rule", () => {
    expect(decideTier3("safeway", false, consent(["safeway"]), VERSION)).toEqual({
      ok: false,
      reason: "flag_off",
    });
    expect(decideTier3("costco", true, consent(["safeway"]), VERSION)).toEqual({
      ok: false,
      reason: "no_consent",
    });
    expect(decideTier3("safeway", true, consent(["safeway"]), VERSION)).toEqual({ ok: true });
    expect(TIER3_RETAILER_IDS).toEqual(["safeway", "costco"]);
  });
});

describe("the registry gate", () => {
  it("getAdapter('safeway') reaches the stub adapter only when the gate allows it", async () => {
    const stub = new MockRetailer({ id: "safeway" });
    registerAdapter(stub);
    const kroger = new MockRetailer({ id: "kroger" });
    registerAdapter(kroger);

    const denied = gateWith({ consent: consent(["costco"]) });
    const remove = await installTier3Gate(HOUSEHOLD, denied.gate);
    let caught: unknown;
    try {
      getAdapter("safeway");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Tier3GateError);
    expect((caught as Tier3GateError).reason).toBe("no_consent");
    // Retailers that are not Tier 3 pass through.
    expect(getAdapter("kroger")).toBe(kroger);
    remove();

    const allowed = gateWith({ consent: consent(["safeway"]) });
    await installTier3Gate(HOUSEHOLD, allowed.gate);
    expect(getAdapter("safeway")).toBe(stub);
    expect(await getGatedAdapter(HOUSEHOLD, "safeway", allowed.gate)).toBe(stub);
    await expect(getGatedAdapter(HOUSEHOLD, "costco", allowed.gate)).rejects.toBeInstanceOf(
      Tier3GateError,
    );
  });

  it("behaves as before when no gate is set, and the hook runs before the adapter lookup", () => {
    const registry = new AdapterRegistry();
    const stub = new MockRetailer({ id: "costco" });
    registry.register(stub);
    expect(registry.getGate()).toBeNull();
    expect(registry.getAdapter("costco")).toBe(stub);

    const hook = vi.fn((id: string) => {
      if (id === "costco") throw new RetailerNotSupportedError("costco", "test", "blocked");
    });
    registry.setGate(hook);
    expect(() => registry.getAdapter("costco")).toThrow("blocked");
    expect(hook).toHaveBeenCalledWith("costco");
    // Still the old error for a retailer with no adapter, after the hook ran.
    expect(() => registry.getAdapter("kroger")).toThrow(RetailerNotSupportedError);
    registry.setGate(null);
    expect(registry.getAdapter("costco")).toBe(stub);
    registry.setGate(hook);
    registry.clear();
    expect(registry.getGate()).toBeNull();
  });

  it("an installed gate can be removed without touching a newer one", async () => {
    const registry = new AdapterRegistry();
    const first = await installTier3Gate(HOUSEHOLD, gateWith({}).gate, registry);
    const newer = () => {};
    registry.setGate(newer);
    first();
    expect(registry.getGate()).toBe(newer);
  });
});
