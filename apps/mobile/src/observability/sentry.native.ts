// Sentry on iOS and Android (WS15): @sentry/react-native, started once from init.ts. The web build
// uses sentry.ts, which does nothing: the web export has no Sentry in v1 (WS13 follow-up).
import * as Sentry from "@sentry/react-native";
import { publicEnv } from "../lib/env";
import { sentryInitOptions } from "./sentryOptions";

let started = false;

/** Starts Sentry when EXPO_PUBLIC_SENTRY_DSN is set. Safe to call twice; never throws. */
export function initSentry(): boolean {
  if (started) return true;
  try {
    const options = sentryInitOptions({
      dsn: publicEnv.sentryDsn,
      release: publicEnv.gitSha,
      environment: publicEnv.sentryEnvironment,
      dev: __DEV__,
    });
    if (!options) return false;
    Sentry.init(options as unknown as Parameters<typeof Sentry.init>[0]);
    started = true;
  } catch {
    started = false;
  }
  return started;
}

/** Tags every later event with the active household, or clears the tag at sign-out. */
export function setSentryHousehold(householdId: string | null): void {
  if (!started) return;
  try {
    Sentry.setTag("household_id", householdId ?? undefined);
    // No user object, ever: the household id is the only identifier an event carries.
    Sentry.setUser(null);
  } catch {
    // Reporting never breaks the app.
  }
}

/** Reports a handled error with the active household's tag. */
export function captureError(error: unknown): void {
  if (!started) return;
  try {
    Sentry.captureException(error);
  } catch {
    // Reporting never breaks the app.
  }
}
