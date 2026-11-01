// Sentry on the web build: nothing. @sentry/react-native is a native module and stays out of the
// web export; sentry.native.ts is the iOS and Android implementation. A browser SDK for the web
// and desktop builds is a WS13 follow-up. These functions keep the same names so callers need no
// platform check.

/** The web build never starts Sentry. */
export function initSentry(): boolean {
  return false;
}

export function setSentryHousehold(_householdId: string | null): void {}

export function captureError(_error: unknown): void {}
