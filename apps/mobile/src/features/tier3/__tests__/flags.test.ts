// WS08: the kill switch is on unless PostHog says off (orchestrator correction 8).
import { describe, expect, it, vi } from "vitest";
import {
  createPostHogTier3Flags,
  evaluateTier3Flag,
  POSTHOG_FLAG_OPTIONS,
  type PostHogFlagClient,
} from "../flags";

describe("the PostHog client options (fix round item 7)", () => {
  it("send no events, flag reads included, and keep nothing on the device", () => {
    expect(POSTHOG_FLAG_OPTIONS).toMatchObject({
      sendFeatureFlagEvent: false,
      captureAppLifecycleEvents: false,
      persistence: "memory",
      disableGeoip: true,
    });
  });
});

function client(
  value: unknown,
  payload: unknown,
  reload: () => Promise<unknown> = async () => ({}),
) {
  return {
    reloadFeatureFlagsAsync: vi.fn(reload),
    getFeatureFlag: vi.fn(() => value as boolean | string | undefined),
    getFeatureFlagPayload: vi.fn(() => payload),
  } satisfies PostHogFlagClient;
}

describe("tier3 flags", () => {
  it("is on with no PostHog key", async () => {
    expect(await createPostHogTier3Flags(null).isEnabled("safeway")).toBe(true);
  });

  it("is off only when PostHog says off, for all or for one retailer", async () => {
    expect(await createPostHogTier3Flags(client(false, null)).isEnabled("costco")).toBe(false);
    const perRetailer = createPostHogTier3Flags(client(true, { off: ["costco"] }));
    expect(await perRetailer.isEnabled("costco")).toBe(false);
    expect(await perRetailer.isEnabled("safeway")).toBe(true);
    expect(await createPostHogTier3Flags(client(true, null)).isEnabled("safeway")).toBe(true);
  });

  it("is on when PostHog cannot be reached, answers late, or has no such flag", async () => {
    const unreachable = client(false, null, async () => {
      throw new Error("offline");
    });
    expect(await createPostHogTier3Flags(unreachable).isEnabled("safeway")).toBe(true);
    expect(await createPostHogTier3Flags(client(undefined, null)).isEnabled("safeway")).toBe(true);
    vi.useFakeTimers();
    try {
      const slow = createPostHogTier3Flags(client(false, null, () => new Promise(() => {})));
      const pending = slow.isEnabled("safeway");
      await vi.advanceTimersByTimeAsync(3500);
      expect(await pending).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("evaluateTier3Flag treats variants and odd payloads as on", () => {
    expect(evaluateTier3Flag("control", null, "safeway")).toBe(true);
    expect(evaluateTier3Flag(true, ["costco"], "costco")).toBe(true);
    expect(evaluateTier3Flag(true, { off: "costco" }, "costco")).toBe(true);
    expect(evaluateTier3Flag(false, null, "safeway")).toBe(false);
  });
});
