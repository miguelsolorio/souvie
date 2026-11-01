// The app's wiring for tier3Gate (WS08): the PostHog kill switch from flags.ts and the household's
// consent from Supabase, at the copy version in consent.ts. WS10 calls configureAppTier3Gate (or
// installTier3Gate for a run) before it asks the registry for a Safeway or Costco adapter.
import type { MpClient } from "@mp/db";
import {
  configureTier3Gate,
  createTier3Gate,
  type Tier3Gate,
  type Tier3GateDeps,
} from "@mp/retailers";
import { CONSENT_VERSION, parseConsent } from "./consent";
import { type Tier3Flags, tier3Flags } from "./flags";

export function appTier3GateDeps(
  client: MpClient,
  flags: Tier3Flags = tier3Flags(),
): Tier3GateDeps {
  return {
    isFlagOn: (retailer) => flags.isEnabled(retailer),
    async readConsent(householdId) {
      const { data, error } = await client
        .from("households")
        .select("tier3_consent")
        .eq("id", householdId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return parseConsent(data?.tier3_consent ?? null);
    },
    consentVersion: CONSENT_VERSION,
  };
}

/** Builds the gate for this client and makes it the one tier3Gate() uses. */
export function configureAppTier3Gate(client: MpClient, flags?: Tier3Flags): Tier3Gate {
  const deps = appTier3GateDeps(client, flags);
  configureTier3Gate(deps);
  return createTier3Gate(deps);
}
