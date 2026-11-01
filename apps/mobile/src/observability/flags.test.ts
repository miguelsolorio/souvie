// Acceptance criterion 3 (the app half): useFlag's store is on by default, flips within one
// foreground when PostHog says off, and decides like the worker's getFlag.
import { describe, expect, it, vi } from "vitest";
import { evaluateFlag as workerEvaluate } from "../../../../services/shopper-worker/src/observability/flags";
import { evaluateTier3Flag } from "../features/tier3/flags";
import { createFlagStore, evaluateFlag, FLAG_DEFAULTS, FLAG_NAMES, type FlagClient } from "./flags";

function client(initial: Record<string, boolean | string | undefined> = {}) {
  const flags = { ...initial };
  const reload = vi.fn(async () => ({}));
  const c: FlagClient = {
    reloadFeatureFlagsAsync: reload,
    getFeatureFlag: (key) => flags[key],
  };
  return { c, flags, reload };
}

describe("flag defaults", () => {
  it("every flag is on, and these are the three names", () => {
    expect([...FLAG_NAMES]).toEqual([
      "tier3_browser_checkout",
      "ai_suggestions_v2",
      "shopping_agent_enabled",
    ]);
    expect(Object.values(FLAG_DEFAULTS)).toEqual([true, true, true]);
  });

  it("useFlag('tier3_browser_checkout') is false only when PostHog says false: on with no client", () => {
    const store = createFlagStore(null);
    for (const name of FLAG_NAMES) expect(store.get(name)).toBe(true);
  });
});

describe("the flag store", () => {
  it("is on until PostHog answers, then follows it", async () => {
    const { c, flags } = client({ tier3_browser_checkout: false });
    const store = createFlagStore(c);
    expect(store.get("tier3_browser_checkout")).toBe(true);
    await store.refresh();
    expect(store.get("tier3_browser_checkout")).toBe(false);
    expect(store.get("shopping_agent_enabled")).toBe(true);
    flags.tier3_browser_checkout = true;
    await store.refresh();
    expect(store.get("tier3_browser_checkout")).toBe(true);
  });

  it("flips within one foreground: the first subscriber starts a refresh on activation", async () => {
    const { c, flags, reload } = client({});
    const app: { foreground: (() => void) | null } = { foreground: null };
    const store = createFlagStore(c, {
      onForeground(callback) {
        app.foreground = callback;
        return () => {
          app.foreground = null;
        };
      },
    });
    const seen: boolean[] = [];
    const unsubscribe = store.subscribe(() => seen.push(store.get("shopping_agent_enabled")));
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(seen).toEqual([]);

    // The flag is switched off in PostHog while the app is in the background.
    flags.shopping_agent_enabled = false;
    app.foreground?.();
    await vi.waitFor(() => expect(seen).toEqual([false]));
    expect(store.get("shopping_agent_enabled")).toBe(false);

    unsubscribe();
    expect(app.foreground).toBeNull();
  });

  it("tells subscribers only when something changed", async () => {
    const { c } = client({ shopping_agent_enabled: true });
    const store = createFlagStore(c);
    const listener = vi.fn();
    store.subscribe(listener);
    await store.refresh();
    await store.refresh();
    expect(listener).not.toHaveBeenCalled();
  });

  it("shares one reload between a refresh and a foreground that arrive together", async () => {
    const { c, reload } = client({});
    const store = createFlagStore(c);
    await Promise.all([store.refresh(), store.refresh()]);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("keeps the last answer when PostHog fails or answers late", async () => {
    const failing: FlagClient = {
      reloadFeatureFlagsAsync: async () => {
        throw new Error("offline");
      },
      getFeatureFlag: () => false,
    };
    const store = createFlagStore(failing);
    await store.refresh();
    expect(store.get("tier3_browser_checkout")).toBe(true);

    vi.useFakeTimers();
    try {
      const slow: FlagClient = {
        reloadFeatureFlagsAsync: () => new Promise(() => {}),
        getFeatureFlag: () => false,
      };
      const slowStore = createFlagStore(slow, { timeoutMs: 500 });
      const pending = slowStore.refresh();
      await vi.advanceTimersByTimeAsync(600);
      await pending;
      expect(slowStore.get("tier3_browser_checkout")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the rule, against the worker's and WS08's", () => {
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
      expect(workerEvaluate(value, payload, retailer)).toBe(expected);
      if (retailer) {
        expect(evaluateTier3Flag(value, payload, retailer as "safeway" | "costco")).toBe(expected);
      }
    },
  );
});
