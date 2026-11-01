// Feature flags in the app (WS15, orchestrator correction 5). Each flag is a kill switch, so it is
// ON unless PostHog says OFF: with no key, with PostHog unreachable, with a slow answer, and with
// any answer but an explicit `false`. That is the rule WS08 built into features/tier3/flags.ts and
// the worker's getFlag follows it too (services/shopper-worker/src/observability/flags.ts).
//
//   tier3_browser_checkout   per-retailer kill switch for Tier 3 (the Tier 3 connect flow reads the
//                            per-retailer form through tier3Flags()); here it is the overall switch.
//   shopping_agent_enabled   kill switch for the shopping agent; "Shop this list" hides when off.
//   ai_suggestions_v2        a rollout flag with no code behind it yet; on by default.
//
// This file is pure (no React, no SDK) so the store is tested without a device. `useFlag.ts`
// binds it to React and to the app's foreground.

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

/** The part of posthog-react-native this file uses. */
export interface FlagClient {
  reloadFeatureFlagsAsync(): Promise<unknown>;
  getFeatureFlag(key: string): boolean | string | undefined;
}

export const FLAG_TIMEOUT_MS = 3000;

export interface FlagStoreOptions {
  /** Called when the app returns to the foreground; returns the unsubscribe. */
  onForeground?: (callback: () => void) => () => void;
  timeoutMs?: number;
}

export interface FlagStore {
  /** The flag now: the default until PostHog has answered. */
  get(name: FlagName): boolean;
  /** Re-reads every flag from PostHog. Never rejects; a failure leaves the last answer. */
  refresh(): Promise<void>;
  /** For useSyncExternalStore. The first subscriber starts the foreground refresh; the last stops it. */
  subscribe(listener: () => void): () => void;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Flags from a PostHog client, or all defaults with none. */
export function createFlagStore(
  client: FlagClient | null,
  options: FlagStoreOptions = {},
): FlagStore {
  const timeoutMs = options.timeoutMs ?? FLAG_TIMEOUT_MS;
  const values = new Map<FlagName, boolean>();
  const listeners = new Set<() => void>();
  let stopForeground: (() => void) | null = null;
  let loading: Promise<void> | null = null;

  const refresh = (): Promise<void> => {
    if (!client) return Promise.resolve();
    // One reload at a time: a foreground that arrives while one is running shares it.
    loading ??= (async () => {
      try {
        const reloaded = await withTimeout(client.reloadFeatureFlagsAsync(), timeoutMs);
        if (reloaded === "timeout") return;
        let changed = false;
        for (const name of FLAG_NAMES) {
          const next = evaluateFlag(client.getFeatureFlag(name));
          if ((values.get(name) ?? FLAG_DEFAULTS[name]) !== next) changed = true;
          values.set(name, next);
        }
        if (changed) for (const listener of [...listeners]) listener();
      } catch {
        // A failed reload leaves the last answer, which starts as the default (on).
      } finally {
        loading = null;
      }
    })();
    return loading;
  };

  return {
    get: (name) => values.get(name) ?? FLAG_DEFAULTS[name],
    refresh,
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        void refresh();
        stopForeground = options.onForeground?.(() => void refresh()) ?? null;
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          stopForeground?.();
          stopForeground = null;
        }
      };
    },
  };
}
