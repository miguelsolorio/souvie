// The two components of the app's observability that live in effects: ObservabilityLifecycle (the
// household on Sentry and PostHog, a PostHog reset only at sign-out) and useFlag (a flag that flips
// within one foreground). Rendered with the real React renderer; the SDKs are stood in.
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  household: { data: undefined as { id: string } | undefined },
  session: { user: undefined as { id: string } | undefined },
  appState: [] as Array<(state: string) => void>,
  sentryHousehold: vi.fn(),
  posthogGroup: vi.fn(),
  posthogReset: vi.fn(),
}));

vi.mock("react-native", () => ({
  AppState: {
    addEventListener: (_type: string, callback: (state: string) => void) => {
      h.appState.push(callback);
      return { remove: () => void h.appState.splice(h.appState.indexOf(callback), 1) };
    },
  },
}));
vi.mock("@mp/db", () => ({
  useHousehold: () => h.household,
  useSession: () => h.session,
}));
vi.mock("./sentry", () => ({ setSentryHousehold: h.sentryHousehold }));

import { createFlagStore } from "./flags";
import { ObservabilityLifecycle } from "./ObservabilityLifecycle";
import { type PostHogClient, setPostHogForTests } from "./posthog";
import { setFlagStoreForTests, useFlag } from "./useFlag";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOUSEHOLD = "0a000000-0000-4000-8000-00000000000a";

function posthog(): PostHogClient {
  return {
    capture: vi.fn(),
    group: h.posthogGroup,
    reset: h.posthogReset,
    reloadFeatureFlagsAsync: async () => ({}),
    getFeatureFlag: () => undefined,
  };
}

beforeEach(() => {
  h.household = { data: undefined };
  h.session = { user: undefined };
  h.appState.length = 0;
  h.sentryHousehold.mockReset();
  h.posthogGroup.mockReset();
  h.posthogReset.mockReset();
  setPostHogForTests(posthog());
  setFlagStoreForTests(undefined);
});

describe("ObservabilityLifecycle", () => {
  it("tags Sentry and groups PostHog once a household is active, and clears Sentry's tag when none", () => {
    h.session = { user: { id: "u1" } };
    let tree: ReturnType<typeof create> | undefined;
    act(() => {
      tree = create(createElement(ObservabilityLifecycle));
    });
    // While the household is loading nothing is grouped, and nothing is reset.
    expect(h.sentryHousehold).toHaveBeenLastCalledWith(null);
    expect(h.posthogGroup).not.toHaveBeenCalled();
    expect(h.posthogReset).not.toHaveBeenCalled();

    h.household = { data: { id: HOUSEHOLD } };
    act(() => {
      tree?.update(createElement(ObservabilityLifecycle));
    });
    expect(h.sentryHousehold).toHaveBeenLastCalledWith(HOUSEHOLD);
    expect(h.posthogGroup).toHaveBeenCalledWith("household", HOUSEHOLD);
  });

  it("resets PostHog's anonymous id at sign-out, and not at launch with nobody signed in", () => {
    let tree: ReturnType<typeof create> | undefined;
    // Launch signed out: no reset.
    act(() => {
      tree = create(createElement(ObservabilityLifecycle));
    });
    expect(h.posthogReset).not.toHaveBeenCalled();

    h.session = { user: { id: "u1" } };
    act(() => {
      tree?.update(createElement(ObservabilityLifecycle));
    });
    expect(h.posthogReset).not.toHaveBeenCalled();

    h.session = { user: undefined };
    act(() => {
      tree?.update(createElement(ObservabilityLifecycle));
    });
    expect(h.posthogReset).toHaveBeenCalledTimes(1);
  });
});

describe("useFlag", () => {
  function Probe({ onValue }: { onValue: (value: boolean) => void }) {
    onValue(useFlag("shopping_agent_enabled"));
    return null;
  }

  it("is on at first, and flips to off within one foreground when PostHog says off", async () => {
    const flags: Record<string, boolean | undefined> = {};
    const reload = vi.fn(async () => ({}));
    setFlagStoreForTests(
      createFlagStore(
        { reloadFeatureFlagsAsync: reload, getFeatureFlag: (key) => flags[key] },
        {
          onForeground(callback) {
            const listener = (state: string) => {
              if (state === "active") callback();
            };
            h.appState.push(listener);
            return () => void h.appState.splice(h.appState.indexOf(listener), 1);
          },
        },
      ),
    );
    const seen: boolean[] = [];
    let tree: ReturnType<typeof create> | undefined;
    await act(async () => {
      tree = create(createElement(Probe, { onValue: (v) => seen.push(v) }));
    });
    expect(seen.at(-1)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(h.appState).toHaveLength(1);

    // Switched off in PostHog; the app comes back to the foreground.
    flags.shopping_agent_enabled = false;
    await act(async () => {
      h.appState[0]?.("active");
    });
    expect(seen.at(-1)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(2);

    // And back on.
    flags.shopping_agent_enabled = true;
    await act(async () => {
      h.appState[0]?.("active");
    });
    expect(seen.at(-1)).toBe(true);

    // Unmounting stops listening.
    act(() => tree?.unmount());
    expect(h.appState).toHaveLength(0);
  });

  it("stays on, with no PostHog client at all", async () => {
    setPostHogForTests(null);
    const seen: boolean[] = [];
    await act(async () => {
      create(createElement(Probe, { onValue: (v) => seen.push(v) }));
    });
    expect(seen.every((v) => v)).toBe(true);
  });
});
