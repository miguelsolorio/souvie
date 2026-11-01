// Acceptance criterion 3 (the worker half): the flags default on, flip on an explicit off from
// PostHog, and `getFlag` agrees with the app's kill-switch semantics (features/tier3/flags.ts).
import { describe, expect, it, vi } from "vitest";
import { createFlags, evaluateFlag, FLAG_DEFAULTS, FLAG_NAMES, type FlagClient } from "./flags.ts";

const HOUSEHOLD = "0a000000-0000-4000-8000-00000000000a";

function client(
  value: unknown,
  payload?: unknown,
): FlagClient & { getFeatureFlag: ReturnType<typeof vi.fn> } {
  return {
    getFeatureFlag: vi.fn(async () => value as boolean | string | undefined),
    getFeatureFlagPayload: vi.fn(async () => payload),
  };
}

describe("flag defaults", () => {
  it("every flag is on, and the three names are the ones the docs use", () => {
    expect([...FLAG_NAMES]).toEqual([
      "tier3_browser_checkout",
      "ai_suggestions_v2",
      "shopping_agent_enabled",
    ]);
    expect(Object.values(FLAG_DEFAULTS)).toEqual([true, true, true]);
  });

  it("are on with no PostHog client at all", async () => {
    const flags = createFlags(null);
    for (const name of FLAG_NAMES) expect(await flags.getFlag(name, HOUSEHOLD)).toBe(true);
  });
});

describe("getFlag", () => {
  it("is off only when PostHog says false", async () => {
    expect(await createFlags(client(false)).getFlag("tier3_browser_checkout", HOUSEHOLD)).toBe(
      false,
    );
    expect(await createFlags(client(true)).getFlag("tier3_browser_checkout", HOUSEHOLD)).toBe(true);
    expect(await createFlags(client("variant-a")).getFlag("ai_suggestions_v2", HOUSEHOLD)).toBe(
      true,
    );
    expect(await createFlags(client(undefined)).getFlag("shopping_agent_enabled", HOUSEHOLD)).toBe(
      true,
    );
  });

  it("asks PostHog about the household, as an opaque id and a group, without a flag-called event", async () => {
    const c = client(true);
    await createFlags(c).getFlag("shopping_agent_enabled", HOUSEHOLD);
    expect(c.getFeatureFlag).toHaveBeenCalledWith("shopping_agent_enabled", HOUSEHOLD, {
      groups: { household: HOUSEHOLD },
      disableGeoip: true,
      sendFeatureFlagEvents: false,
    });
  });

  it("switches one retailer off through the payload and leaves the others on", async () => {
    const flags = createFlags(client(true, { off: ["costco"] }));
    expect(await flags.getFlag("tier3_browser_checkout", HOUSEHOLD, { retailer: "costco" })).toBe(
      false,
    );
    expect(await flags.getFlag("tier3_browser_checkout", HOUSEHOLD, { retailer: "safeway" })).toBe(
      true,
    );
    // Without a retailer the payload is not consulted.
    expect(await flags.getFlag("tier3_browser_checkout", HOUSEHOLD)).toBe(true);
  });

  it("reads as on when PostHog fails, answers late, or throws", async () => {
    const warn = vi.fn();
    const failing: FlagClient = {
      getFeatureFlag: async () => {
        throw new Error("offline");
      },
    };
    expect(
      await createFlags(failing, { onWarning: warn }).getFlag("tier3_browser_checkout", HOUSEHOLD),
    ).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      "flag tier3_browser_checkout failed (offline); reading it as on",
    );

    vi.useFakeTimers();
    try {
      const slow: FlagClient = { getFeatureFlag: () => new Promise(() => {}) };
      const pending = createFlags(slow, { timeoutMs: 500, onWarning: warn }).getFlag(
        "shopping_agent_enabled",
        HOUSEHOLD,
      );
      await vi.advanceTimersByTimeAsync(600);
      expect(await pending).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an answer for a minute, so a run does not wait on the network", async () => {
    let t = 0;
    const c = client(false);
    const flags = createFlags(c, { now: () => t, cacheMs: 60_000 });
    await flags.getFlag("shopping_agent_enabled", HOUSEHOLD);
    await flags.getFlag("shopping_agent_enabled", HOUSEHOLD);
    expect(c.getFeatureFlag).toHaveBeenCalledTimes(1);
    t = 61_000;
    await flags.getFlag("shopping_agent_enabled", HOUSEHOLD);
    expect(c.getFeatureFlag).toHaveBeenCalledTimes(2);
    // Another household is its own question.
    await flags.getFlag("shopping_agent_enabled", "0b000000-0000-4000-8000-00000000000b");
    expect(c.getFeatureFlag).toHaveBeenCalledTimes(3);
  });
});

describe("evaluateFlag, the rule the app's useFlag shares", () => {
  // The same table is run against the app's copy of the rule in
  // apps/mobile/src/observability/flags.test.ts.
  const cases: Array<[unknown, unknown, string | undefined, boolean]> = [
    [false, null, "safeway", false],
    [true, null, "safeway", true],
    [true, { off: ["costco"] }, "costco", false],
    [true, { off: ["costco"] }, "safeway", true],
    [true, { off: ["costco"] }, undefined, true],
    [true, { off: "costco" }, "costco", true],
    ["control", null, "safeway", true],
    [undefined, undefined, "safeway", true],
    [false, { off: ["safeway"] }, "costco", false],
  ];
  it.each(cases)(
    "value %j, payload %j, retailer %s is %s",
    (value, payload, retailer, expected) => {
      expect(evaluateFlag(value, payload, retailer)).toBe(expected);
    },
  );
});
