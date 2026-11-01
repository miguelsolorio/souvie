// Acceptance criterion 2 (the app half): the typed helpers send the brief's event names with the
// brief's properties, and nothing else, to the client PostHog gives the app. And never throw.
import { afterEach, describe, expect, it, vi } from "vitest";
import { EVENT_NAMES } from "./events";
import { type PostHogClient, setPostHogForTests } from "./posthog";
import { track } from "./track";

function client() {
  const sent: Array<{ event: string; properties: Record<string, unknown> | undefined }> = [];
  const posthog: PostHogClient = {
    capture: (event, properties) => void sent.push({ event, properties }),
    group: vi.fn(),
    reloadFeatureFlagsAsync: async () => ({}),
    getFeatureFlag: () => undefined,
  };
  return { posthog, sent };
}

afterEach(() => setPostHogForTests(undefined));

describe("track", () => {
  it("has one function per event, and sends it with exactly the listed properties", () => {
    const { posthog, sent } = client();
    setPostHogForTests(posthog);
    track.onboardingCompleted({ steps_completed: 8, store_connected: false });
    track.planCreated({ entries: 5, source: "ai" });
    track.listBuilt({ items: 31, pantry_excluded: 6 });
    track.runStarted({ retailer: "kroger", trigger: "manual" });
    track.cartReady({ retailer: "kroger", items: 29, subtotal_bucket: "100_150" });
    track.runApproved({ retailer: "kroger", review_edits: 2 });
    track.checkoutCompleted({ retailer: "safeway", tier: 3 });

    expect(sent.map((s) => s.event)).toEqual([...EVENT_NAMES]);
    expect(sent.map((s) => s.properties)).toEqual([
      { steps_completed: 8, store_connected: false },
      { entries: 5, source: "ai" },
      { items: 31, pantry_excluded: 6 },
      { retailer: "kroger", trigger: "manual" },
      { retailer: "kroger", items: 29, subtotal_bucket: "100_150" },
      { retailer: "kroger", review_edits: 2 },
      { retailer: "safeway", tier: 3 },
    ]);
  });

  it("drops a property that is not on the event's list, so no PII rides along", () => {
    const { posthog, sent } = client();
    setPostHogForTests(posthog);
    // A variable, not a literal: TypeScript would refuse the extra keys, and this is the runtime guard.
    const careless = {
      items: 3,
      pantry_excluded: 1,
      email: "a@b.test",
      list_name: "Week of Nov 2",
    };
    track.listBuilt(careless);
    expect(sent[0]?.properties).toEqual({ items: 3, pantry_excluded: 1 });
    expect(JSON.stringify(sent)).not.toMatch(/@|Nov/);
  });

  it("does nothing, and does not throw, without a client", () => {
    setPostHogForTests(null);
    expect(() => track.planCreated({ entries: 1, source: "manual" })).not.toThrow();
  });

  it("does not throw when the client does", () => {
    setPostHogForTests({
      capture: () => {
        throw new Error("storage full");
      },
      group: vi.fn(),
      reloadFeatureFlagsAsync: async () => ({}),
      getFeatureFlag: () => undefined,
    });
    expect(() => track.runApproved({ retailer: "kroger", review_edits: 0 })).not.toThrow();
  });
});
