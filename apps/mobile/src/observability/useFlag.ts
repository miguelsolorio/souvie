// useFlag(name): a feature flag as a boolean, on unless PostHog says off (flags.ts). It is the
// default until PostHog has answered, and it flips within one foreground of the app: the store
// reloads the flags when the app becomes active, and every component reading the flag re-renders.
//
//   const enabled = useFlag("shopping_agent_enabled");
import { useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { createFlagStore, FLAG_DEFAULTS, type FlagName, type FlagStore } from "./flags";
import { getPostHog } from "./posthog";

export type { FlagName } from "./flags";

let store: FlagStore | undefined;

function flagStore(): FlagStore {
  store ??= createFlagStore(getPostHog(), {
    onForeground(callback) {
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") callback();
      });
      return () => subscription.remove();
    },
  });
  return store;
}

/** Tests replace the store. */
export function setFlagStoreForTests(next: FlagStore | undefined): void {
  store = next;
}

export function useFlag(name: FlagName): boolean {
  const flags = flagStore();
  return useSyncExternalStore(
    flags.subscribe,
    () => flags.get(name),
    () => FLAG_DEFAULTS[name],
  );
}
