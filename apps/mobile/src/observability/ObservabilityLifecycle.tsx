import { useHousehold } from "@mp/db";
import { useEffect } from "react";
import { setPostHogHousehold } from "./posthog";
import { setSentryHousehold } from "./sentry";

/**
 * Tells Sentry and PostHog which household is active, so an error and an event carry the
 * `household_id` (an opaque uuid) and nothing about the person. Cleared when there is none.
 * Mounted once under the Supabase provider, next to AuthLifecycle.
 */
export function ObservabilityLifecycle() {
  const household = useHousehold();
  const householdId = household.data?.id ?? null;
  useEffect(() => {
    setSentryHousehold(householdId);
    setPostHogHousehold(householdId);
  }, [householdId]);
  return null;
}
