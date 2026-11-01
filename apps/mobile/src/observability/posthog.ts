// PostHog in the app (WS15): one client, shared by the seven product events (track.ts) and the
// feature flags (useFlag.ts). Without EXPO_PUBLIC_POSTHOG_KEY there is no client: nothing is sent
// and every flag reads as on.
//
// What PostHog receives (docs/05 §Privacy): event names, the seven properties in events.ts, an
// anonymous device id, and the household as a group (an opaque uuid). No email, no name, no
// recipe, product or dollar amount. App lifecycle events, screen views, autocapture, GeoIP and the
// $feature_flag_called event are all off, so the seven events are the whole stream.
//
// Tier 3's own kill-switch reader (features/tier3/flags.ts, WS08) keeps its flags-only client;
// both ask PostHog the same question and apply the same rule (flags.ts).
import { publicEnv } from "../lib/env";
import type { FlagClient } from "./flags";

/** The part of posthog-react-native this file and track.ts use. */
export interface PostHogClient extends FlagClient {
  capture(event: string, properties?: Record<string, unknown>): void;
  group(type: string, key: string, properties?: Record<string, unknown>): void;
  reset?(): void;
}

export const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

/**
 * How the client is built: events on, everything automatic off. The anonymous id persists on the
 * device (the library's default storage) so a funnel spans launches.
 */
export function posthogOptions(host: string | undefined) {
  return {
    host: host?.trim() || DEFAULT_POSTHOG_HOST,
    captureAppLifecycleEvents: false,
    sendFeatureFlagEvent: false,
    disableGeoip: true,
    preloadFeatureFlags: false,
  } as const;
}

let client: PostHogClient | null | undefined;

/** The shared client, built on first use; null without a key or if the library cannot start. */
export function getPostHog(): PostHogClient | null {
  if (client !== undefined) return client;
  const key = publicEnv.posthogKey?.trim();
  client = null;
  if (key) {
    try {
      // Loaded lazily so a build without the key never evaluates the module.
      const { PostHog } = require("posthog-react-native") as typeof import("posthog-react-native");
      client = new PostHog(key, posthogOptions(publicEnv.posthogHost)) as unknown as PostHogClient;
    } catch {
      client = null;
    }
  }
  return client;
}

/** Tests replace the client (null: none). */
export function setPostHogForTests(next: PostHogClient | null | undefined): void {
  client = next;
}

/** Groups the device's events under the household. */
export function setPostHogHousehold(householdId: string): void {
  try {
    getPostHog()?.group("household", householdId);
  } catch {
    // Analytics never breaks the app.
  }
}

/** Sign-out: a new anonymous id and no group, so the next person on this device starts clean. */
export function resetPostHog(): void {
  try {
    getPostHog()?.reset?.();
  } catch {
    // Analytics never breaks the app.
  }
}
