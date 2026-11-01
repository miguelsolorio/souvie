// How the app starts Sentry (WS15): pure, so it is tested without the SDK. The native module
// (sentry.native.ts) passes the result to Sentry.init.
//
// What an event carries: the release (the git SHA of the build), the environment, a `household_id`
// tag once a household is active, and the stack. Nothing about a person: `scrubEvent` runs in
// beforeSend and removes the user, the request, headers, cookies, query strings and every email,
// token and key from every string (scrub.ts). No screenshot and no view hierarchy is attached,
// because a screen shows a household's recipes and lists. Performance monitoring and session
// replay are out of scope for v1, so the sample rates are zero.
import { scrubEvent, scrubValue } from "./scrub";

export interface SentryEnv {
  dsn?: string | undefined;
  /** The git SHA the build was made from (EXPO_PUBLIC_GIT_SHA). */
  release?: string | undefined;
  environment?: string | undefined;
  /** __DEV__, for the default environment. */
  dev?: boolean;
}

/** The options for Sentry.init, or null when there is no DSN and Sentry must stay off. */
export function sentryInitOptions(env: SentryEnv): Record<string, unknown> | null {
  const dsn = env.dsn?.trim();
  if (!dsn) return null;
  const release = env.release?.trim();
  return {
    dsn,
    ...(release ? { release } : {}),
    environment: env.environment?.trim() || (env.dev ? "development" : "production"),
    sendDefaultPii: false,
    tracesSampleRate: 0,
    attachScreenshot: false,
    attachViewHierarchy: false,
    enableUserInteractionTracing: false,
    maxBreadcrumbs: 30,
    beforeSend: (event: Record<string, unknown>) => scrubEvent(event),
    beforeBreadcrumb: (breadcrumb: Record<string, unknown>) =>
      scrubValue(breadcrumb) as Record<string, unknown>,
  };
}
