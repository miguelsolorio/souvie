// The Tier 3 kill switch (orchestrator correction 8). PostHog flag `tier3_browser_checkout` is ON
// unless PostHog says OFF: when the key is absent, when PostHog cannot be reached, and when PostHog
// answers anything but an explicit off, Tier 3 runs. It is per retailer through the flag's payload:
// `{ "off": ["costco"] }` switches only Costco off. docs/05 §Incident basics.
//
// The PostHog client (posthog-react-native) is loaded only when a key exists, sends no events, and
// identifies nobody: it asks for flags with an anonymous id. WS15 may move the client elsewhere.
import { TIER3_FLAG, type Tier3RetailerId } from "@mp/retailers";

export interface Tier3Flags {
  isEnabled(retailer: Tier3RetailerId): Promise<boolean>;
}

/** The decision from what PostHog returned. Off only on an explicit `false` or a payload naming it. */
export function evaluateTier3Flag(
  value: unknown,
  payload: unknown,
  retailer: Tier3RetailerId,
): boolean {
  if (value === false) return false;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const off = (payload as { off?: unknown }).off;
    if (Array.isArray(off) && off.includes(retailer)) return false;
  }
  return true;
}

/** The part of posthog-react-native this file uses. */
export interface PostHogFlagClient {
  reloadFeatureFlagsAsync(): Promise<unknown>;
  getFeatureFlag(key: string): boolean | string | undefined;
  getFeatureFlagPayload(key: string): unknown;
}

export const FLAG_TIMEOUT_MS = 3000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  return Promise.race([
    promise,
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms)),
  ]);
}

/** Flags from a PostHog client. Any failure reads as on. */
export function createPostHogTier3Flags(client: PostHogFlagClient | null): Tier3Flags {
  let loaded: Promise<boolean> | null = null;
  return {
    async isEnabled(retailer) {
      if (!client) return true;
      try {
        loaded ??= withTimeout(client.reloadFeatureFlagsAsync(), FLAG_TIMEOUT_MS).then(
          (r) => r !== "timeout",
          () => false,
        );
        if (!(await loaded)) {
          loaded = null;
          return true;
        }
        return evaluateTier3Flag(
          client.getFeatureFlag(TIER3_FLAG),
          client.getFeatureFlagPayload(TIER3_FLAG),
          retailer,
        );
      } catch {
        return true;
      }
    },
  };
}

/**
 * How the app's PostHog client is built: flags only. No events (lifecycle events and the
 * $feature_flag_called event a flag read would send are off), nothing kept on the device, no GeoIP.
 */
export const POSTHOG_FLAG_OPTIONS = Object.freeze({
  host: "https://us.i.posthog.com",
  persistence: "memory" as const,
  captureAppLifecycleEvents: false,
  sendFeatureFlagEvent: false,
  disableGeoip: true,
  preloadFeatureFlags: false,
});

let appFlags: Tier3Flags | null = null;

/** The app's flags: PostHog when EXPO_PUBLIC_POSTHOG_KEY is set, always on otherwise. */
export function tier3Flags(): Tier3Flags {
  if (appFlags) return appFlags;
  const key = process.env.EXPO_PUBLIC_POSTHOG_KEY?.trim();
  let client: PostHogFlagClient | null = null;
  if (key) {
    try {
      // Loaded lazily so a build without the key never evaluates the module.
      const { PostHog } = require("posthog-react-native") as typeof import("posthog-react-native");
      client = new PostHog(key, { ...POSTHOG_FLAG_OPTIONS }) as unknown as PostHogFlagClient;
    } catch {
      client = null;
    }
  }
  appFlags = createPostHogTier3Flags(client);
  return appFlags;
}

/** Tests replace the app's flags. */
export function setTier3FlagsForTests(flags: Tier3Flags | null): void {
  appFlags = flags;
}
