import { useHousehold, useSession } from "@mp/db";
import { useEffect, useRef } from "react";
import { resetPostHog, setPostHogHousehold } from "./posthog";
import { setSentryHousehold } from "./sentry";

/**
 * Tells Sentry and PostHog which household is active, so an error and an event carry the
 * `household_id` (an opaque uuid) and nothing about the person. Mounted once under the Supabase
 * provider, next to AuthLifecycle.
 *
 * Sentry's tag follows the household, and is cleared when there is none. PostHog's group follows
 * it too, and the anonymous id is reset only at sign-out (a user that goes from signed in to
 * signed out), never while the household is still loading, so a funnel spans app launches.
 */
export function ObservabilityLifecycle() {
  const household = useHousehold();
  const session = useSession();
  const householdId = household.data?.id ?? null;
  const userId = session.user?.id ?? null;
  const previousUser = useRef<string | null>(null);

  useEffect(() => {
    setSentryHousehold(householdId);
    if (householdId) setPostHogHousehold(householdId);
  }, [householdId]);

  useEffect(() => {
    if (previousUser.current !== null && userId === null) resetPostHog();
    previousUser.current = userId;
  }, [userId]);

  return null;
}
