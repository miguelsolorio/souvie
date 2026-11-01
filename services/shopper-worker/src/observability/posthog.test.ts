// The seven events, in the worker (acceptance criterion 2, worker half): exactly these names and
// these properties, nothing else, and no PII.
import { describe, expect, it, vi } from "vitest";
import { EVENT_KEYS, EVENT_NAMES, sanitizeProps, subtotalBucket } from "./events.ts";
import { createAnalytics, createPostHogAnalytics, type PostHogLike } from "./posthog.ts";

const HOUSEHOLD = "0a000000-0000-4000-8000-00000000000a";

function fakeClient() {
  const captured: Array<Parameters<PostHogLike["capture"]>[0]> = [];
  const client: PostHogLike = {
    capture: (message) => void captured.push(message),
    getFeatureFlag: async () => undefined,
    flush: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
  };
  return { client, captured };
}

describe("the event table", () => {
  it("names exactly the seven core-loop events", () => {
    expect([...EVENT_NAMES]).toEqual([
      "onboarding_completed",
      "plan_created",
      "list_built",
      "run_started",
      "cart_ready",
      "run_approved",
      "checkout_completed",
    ]);
  });

  it("lists exactly the brief's properties for each", () => {
    expect(EVENT_KEYS).toEqual({
      onboarding_completed: ["steps_completed", "store_connected"],
      plan_created: ["entries", "source"],
      list_built: ["items", "pantry_excluded"],
      run_started: ["retailer", "trigger"],
      cart_ready: ["retailer", "items", "subtotal_bucket"],
      run_approved: ["retailer", "review_edits"],
      checkout_completed: ["retailer", "tier"],
    });
  });

  it("buckets a subtotal, so no event carries what a household spent", () => {
    expect([0, 49.99, 50, 99.99, 100, 149.99, 150, 199.99, 200, 900].map(subtotalBucket)).toEqual([
      "under_50",
      "under_50",
      "50_100",
      "50_100",
      "100_150",
      "100_150",
      "150_200",
      "150_200",
      "over_200",
      "over_200",
    ]);
    expect(subtotalBucket(null)).toBe("under_50");
    expect(subtotalBucket(Number.NaN)).toBe("under_50");
  });

  it("drops a property that is not on the event's list, and a value that is not a primitive", () => {
    expect(
      sanitizeProps("run_started", {
        retailer: "kroger",
        trigger: "manual",
        email: "a@b.test",
        recipe_title: "Lemon chicken",
        nested: { x: 1 },
      }),
    ).toEqual({ retailer: "kroger", trigger: "manual" });
    expect(sanitizeProps("list_built", { items: Number.NaN, pantry_excluded: 3 })).toEqual({
      pantry_excluded: 3,
    });
    expect(
      sanitizeProps("cart_ready", { retailer: "kroger", items: [1, 2], subtotal_bucket: {} }),
    ).toEqual({
      retailer: "kroger",
    });
  });
});

describe("analytics", () => {
  it("has one helper per event and sends the household as an opaque id and a group", () => {
    const { client, captured } = fakeClient();
    const { track } = createAnalytics({ client });
    track.onboardingCompleted(HOUSEHOLD, { steps_completed: 8, store_connected: true });
    track.planCreated(HOUSEHOLD, { entries: 5, source: "ai" });
    track.listBuilt(HOUSEHOLD, { items: 31, pantry_excluded: 6 });
    track.runStarted(HOUSEHOLD, { retailer: "kroger", trigger: "scheduled" });
    track.cartReady(HOUSEHOLD, { retailer: "kroger", items: 29, subtotal_bucket: "100_150" });
    track.runApproved(HOUSEHOLD, { retailer: "kroger", review_edits: 2 });
    track.checkoutCompleted(HOUSEHOLD, { retailer: "safeway", tier: 3 });
    expect(captured.map((c) => c.event)).toEqual([...EVENT_NAMES]);
    expect(captured[3]).toEqual({
      distinctId: HOUSEHOLD,
      event: "run_started",
      properties: { retailer: "kroger", trigger: "scheduled" },
      groups: { household: HOUSEHOLD },
      disableGeoip: true,
    });
    expect(captured[4]?.properties).toEqual({
      retailer: "kroger",
      items: 29,
      subtotal_bucket: "100_150",
    });
    expect(captured[6]?.properties).toEqual({ retailer: "safeway", tier: 3 });
  });

  it("never sends a property off the list even when a caller adds one", () => {
    const { client, captured } = fakeClient();
    const { track } = createAnalytics({ client });
    track.runApproved(HOUSEHOLD, {
      retailer: "kroger",
      review_edits: 1,
      // @ts-expect-error not a property of run_approved
      product_name: "Whole milk",
    });
    expect(captured[0]?.properties).toEqual({ retailer: "kroger", review_edits: 1 });
    expect(JSON.stringify(captured)).not.toContain("milk");
  });

  it("sends nothing and reads every flag as on without a client", async () => {
    const analytics = createAnalytics();
    expect(analytics.enabled).toBe(false);
    analytics.track.runStarted(HOUSEHOLD, { retailer: "kroger", trigger: "manual" });
    expect(await analytics.flags.getFlag("tier3_browser_checkout", HOUSEHOLD)).toBe(true);
    await analytics.flush();
    await analytics.shutdown();
  });

  it("survives a client that throws", () => {
    const warn = vi.fn();
    const client: PostHogLike = {
      capture: () => {
        throw new Error("socket closed");
      },
      getFeatureFlag: async () => undefined,
    };
    const { track } = createAnalytics({ client, onWarning: warn });
    expect(() =>
      track.runStarted(HOUSEHOLD, { retailer: "kroger", trigger: "manual" }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith("posthog capture failed: socket closed");
  });

  it("flushes and shuts the client down", async () => {
    const { client } = fakeClient();
    const analytics = createAnalytics({ client });
    await analytics.flush();
    await analytics.shutdown(1500);
    expect(client.flush).toHaveBeenCalledTimes(1);
    expect(client.shutdown).toHaveBeenCalledWith(1500);
  });

  it("creates no client without POSTHOG_API_KEY", async () => {
    const analytics = await createPostHogAnalytics({});
    expect(analytics.enabled).toBe(false);
    const blank = await createPostHogAnalytics({ POSTHOG_API_KEY: "  " });
    expect(blank.enabled).toBe(false);
  });
});
