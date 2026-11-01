// Feature flags in the worker (WS15, orchestrator correction 5). The flags are kill switches, so
// each one is ON unless PostHog says OFF: with no key, with PostHog unreachable, with a slow
// answer, and with any answer but an explicit `false`. That is the semantics WS08 built into the
// app's `features/tier3/flags.ts`, and the app's `useFlag` and this `getFlag` agree on it.
//
//   tier3_browser_checkout   per-retailer kill switch for Tier 3 (docs/05 §Incident basics). A
//                            payload {"off": ["costco"]} switches only Costco off.
//   shopping_agent_enabled   kill switch for the shopping agent (docs/05 §Incident basics).
//   ai_suggestions_v2        a rollout flag with no code behind it yet; on by default.
//
// A household's flag is looked up with the household id as the distinct id: an opaque uuid, no
// person. An app flag uses the device's anonymous id, so a flag rolled out to a percentage of
// users can differ between the app and the worker; a plain on/off switch cannot.

export const FLAG_NAMES = [
  "tier3_browser_checkout",
  "ai_suggestions_v2",
  "shopping_agent_enabled",
] as const;
export type FlagName = (typeof FLAG_NAMES)[number];

/** Every flag is on when PostHog has nothing to say. */
export const FLAG_DEFAULTS: Readonly<Record<FlagName, boolean>> = {
  tier3_browser_checkout: true,
  ai_suggestions_v2: true,
  shopping_agent_enabled: true,
};

/** Off only on an explicit `false`, or a payload that names the retailer. */
export function evaluateFlag(value: unknown, payload?: unknown, retailer?: string): boolean {
  if (value === false) return false;
  if (retailer && payload && typeof payload === "object" && !Array.isArray(payload)) {
    const off = (payload as { off?: unknown }).off;
    if (Array.isArray(off) && off.includes(retailer)) return false;
  }
  return true;
}

/** The part of posthog-node this file uses. */
export interface FlagClient {
  getFeatureFlag(
    key: string,
    distinctId: string,
    options?: {
      groups?: Record<string, string>;
      disableGeoip?: boolean;
      sendFeatureFlagEvents?: boolean;
    },
  ): Promise<boolean | string | undefined>;
  getFeatureFlagPayload?(
    key: string,
    distinctId: string,
    matchValue?: boolean | string,
    options?: { groups?: Record<string, string>; disableGeoip?: boolean },
  ): Promise<unknown>;
}

export interface FlagOptions {
  /** How long to wait for PostHog before reading the flag as on. Default 2000. */
  timeoutMs?: number;
  /** How long an answer is kept, per flag and household. Default 60000: a run should not wait on the network. */
  cacheMs?: number;
  now?: () => number;
  onWarning?: (message: string) => void;
}

export interface Flags {
  getFlag(name: FlagName, householdId: string, options?: { retailer?: string }): Promise<boolean>;
}

function timeout<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Flags from a PostHog client, or all-defaults with none. Never throws. */
export function createFlags(client: FlagClient | null, options: FlagOptions = {}): Flags {
  const timeoutMs = options.timeoutMs ?? 2000;
  const cacheMs = options.cacheMs ?? 60_000;
  const now = options.now ?? Date.now;
  const warn = options.onWarning ?? (() => {});
  const cache = new Map<string, { at: number; value: boolean }>();

  return {
    async getFlag(name, householdId, opts = {}) {
      const fallback = FLAG_DEFAULTS[name];
      if (!client) return fallback;
      const key = `${name}|${householdId}|${opts.retailer ?? ""}`;
      const hit = cache.get(key);
      if (hit && now() - hit.at < cacheMs) return hit.value;
      try {
        const callOptions = {
          groups: { household: householdId },
          disableGeoip: true,
          sendFeatureFlagEvents: false,
        };
        const value = await timeout(
          client.getFeatureFlag(name, householdId, callOptions),
          timeoutMs,
        );
        if (value === "timeout") {
          warn(`flag ${name} timed out; reading it as on`);
          return fallback;
        }
        let payload: unknown;
        if (opts.retailer && value !== false && client.getFeatureFlagPayload) {
          const read = await timeout(
            client.getFeatureFlagPayload(name, householdId, value, {
              groups: { household: householdId },
              disableGeoip: true,
            }),
            timeoutMs,
          );
          payload = read === "timeout" ? undefined : read;
        }
        const result = evaluateFlag(value, payload, opts.retailer);
        cache.set(key, { at: now(), value: result });
        return result;
      } catch (error) {
        warn(
          `flag ${name} failed (${error instanceof Error ? error.message : String(error)}); reading it as on`,
        );
        return fallback;
      }
    },
  };
}
