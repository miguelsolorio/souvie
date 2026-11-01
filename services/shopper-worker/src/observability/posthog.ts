// PostHog in the worker (WS15): the product events a run produces, and the feature flags. Without
// POSTHOG_API_KEY nothing is created, nothing is sent, and every flag reads as on.
//
// The worker emits the events only it can see: run_started (every run, manual or scheduled, when a
// worker first takes it) and cart_ready. The helpers for all seven events are here so the property
// shapes have one vocabulary on both sides; the app emits the others (apps/mobile/src/observability).
//
// PII: an event carries the household id as its distinct id and as the `household` group, which is
// an opaque uuid. Properties are counts, booleans and small enums (events.ts drops anything else).
// No recipe, product, address, email or dollar amount, ever (docs/05 §Privacy).
import {
  EVENT_NAMES,
  type EventName,
  type EventProps,
  type SubtotalBucket,
  sanitizeProps,
} from "./events.ts";
import { createFlags, type FlagClient, type Flags } from "./flags.ts";

export const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

/** The part of posthog-node this file uses. */
export interface PostHogLike extends FlagClient {
  capture(message: {
    distinctId: string;
    event: string;
    properties?: Record<string, unknown>;
    groups?: Record<string, string>;
    disableGeoip?: boolean;
  }): void;
  flush?(): Promise<void>;
  shutdown?(timeoutMs?: number): Promise<void>;
}

export type Track = {
  [E in EventName as CamelCase<E>]: (householdId: string, props: EventProps[E]) => void;
};

type CamelCase<S extends string> = S extends `${infer Head}_${infer Tail}`
  ? `${Head}${Capitalize<CamelCase<Tail>>}`
  : S;

function camel(name: string): string {
  return name.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

export interface Analytics {
  readonly enabled: boolean;
  /** One function per event: track.runStarted(householdId, { retailer, trigger }). */
  readonly track: Track;
  /** The raw capture, for a test. Applies the same property allowlist. */
  capture<E extends EventName>(event: E, householdId: string, props: EventProps[E]): void;
  readonly flags: Flags;
  flush(): Promise<void>;
  shutdown(timeoutMs?: number): Promise<void>;
}

export interface AnalyticsOptions {
  client?: PostHogLike | null;
  onWarning?: (message: string) => void;
}

/** Builds analytics around a client, or around none (nothing is sent, flags are on). */
export function createAnalytics(options: AnalyticsOptions = {}): Analytics {
  const client = options.client ?? null;
  const warn = options.onWarning ?? (() => {});

  const capture = <E extends EventName>(event: E, householdId: string, props: EventProps[E]) => {
    if (!client) return;
    try {
      client.capture({
        distinctId: householdId,
        event,
        properties: sanitizeProps(event, props),
        groups: { household: householdId },
        disableGeoip: true,
      });
    } catch (error) {
      warn(`posthog capture failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const track = Object.fromEntries(
    EVENT_NAMES.map((name) => [
      camel(name),
      (householdId: string, props: EventProps[typeof name]) => capture(name, householdId, props),
    ]),
  ) as Track;

  return {
    enabled: client !== null,
    track,
    capture,
    flags: createFlags(client, { onWarning: warn }),
    async flush() {
      try {
        await client?.flush?.();
      } catch (error) {
        warn(`posthog flush failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    async shutdown(timeoutMs = 3000) {
      try {
        await client?.shutdown?.(timeoutMs);
      } catch (error) {
        warn(`posthog shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}

export interface PostHogEnv {
  POSTHOG_API_KEY?: string | undefined;
  POSTHOG_HOST?: string | undefined;
}

/**
 * The real client: posthog-node, loaded only when a key is set. Flushes in small batches so an
 * event leaves within seconds, and sends no person profile for a household.
 */
export async function createPostHogAnalytics(
  env: PostHogEnv,
  onWarning?: (message: string) => void,
): Promise<Analytics> {
  const key = env.POSTHOG_API_KEY?.trim();
  if (!key) return createAnalytics(onWarning ? { onWarning } : {});
  try {
    const { PostHog } = await import("posthog-node");
    const client = new PostHog(key, {
      host: env.POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST,
      flushAt: 10,
      flushInterval: 5000,
      disableGeoip: true,
    });
    return createAnalytics({
      client: client as unknown as PostHogLike,
      ...(onWarning ? { onWarning } : {}),
    });
  } catch (error) {
    onWarning?.(
      `posthog-node could not start: ${error instanceof Error ? error.message : String(error)}`,
    );
    return createAnalytics(onWarning ? { onWarning } : {});
  }
}

export type { SubtotalBucket };
