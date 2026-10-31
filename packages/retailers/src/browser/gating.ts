// tier3Gate (WS08): nothing drives a retailer's website for a household until both hold:
//   * the PostHog flag `tier3_browser_checkout` is on for that retailer. It is a kill switch, not
//     an opt-in: on by default, off only when PostHog says so (docs/05 §Incident basics).
//   * the household accepted the Tier 3 consent copy for that retailer at the current copy
//     version (`households.tier3_consent`, written only by record_tier3_consent).
// Otherwise the gate throws Tier3GateError, a RetailerNotSupportedError with a reason code.
//
// The registry calls the gate before handing out any adapter whose connection is a browser
// session (`installTier3Gate` below). Where the flag and the consent come from is injected, so this
// file stays platform-neutral: the app wires PostHog and Supabase (apps/mobile/src/features/tier3).
import { RetailerNotSupportedError } from "../errors.ts";
import { type AdapterRegistry, defaultRegistry } from "../registry.ts";
import type { RetailerAdapter, RetailerId } from "../types.ts";

/** Retailers whose adapters drive the retailer's own site in a browser session (auth_type browser_session). */
export const TIER3_RETAILER_IDS = ["safeway", "costco"] as const satisfies readonly RetailerId[];
export type Tier3RetailerId = (typeof TIER3_RETAILER_IDS)[number];

export function isTier3Retailer(id: string): id is Tier3RetailerId {
  return (TIER3_RETAILER_IDS as readonly string[]).includes(id);
}

/** The PostHog flag. Its payload may switch single retailers off: `{ "off": ["costco"] }`. */
export const TIER3_FLAG = "tier3_browser_checkout";

/** `households.tier3_consent` as stored. */
export interface Tier3Consent {
  accepted_at: string;
  by_user_id: string;
  retailers: string[];
  copy_version: string;
}

export type Tier3GateReason = "flag_off" | "no_consent" | "stale_consent";

export type Tier3Decision = { ok: true } | { ok: false; reason: Tier3GateReason };

const REASON_TEXT: Record<Tier3GateReason, string> = {
  flag_off: "Shopping on this store's website is switched off for now.",
  no_consent: "The household has not agreed to the terms for shopping on this store's website.",
  stale_consent: "The terms for shopping on this store's website changed and need a new agreement.",
};

export class Tier3GateError extends RetailerNotSupportedError {
  readonly reason: Tier3GateReason;

  constructor(retailer: RetailerId, reason: Tier3GateReason) {
    super(retailer, "tier3", REASON_TEXT[reason]);
    this.name = "Tier3GateError";
    this.reason = reason;
  }
}

export interface Tier3GateDeps {
  /** Kill switch lookup. Resolve true when the flag cannot be read: off only on an explicit no. */
  isFlagOn(retailer: Tier3RetailerId): Promise<boolean>;
  /** The household's stored consent, or null. */
  readConsent(householdId: string): Promise<Tier3Consent | null>;
  /** The consent copy version the app shows now (CONSENT_VERSION). */
  consentVersion: string;
}

/** The pure decision, given the flag value and the stored consent. */
export function decideTier3(
  retailer: Tier3RetailerId,
  flagOn: boolean,
  consent: Tier3Consent | null,
  consentVersion: string,
): Tier3Decision {
  if (!flagOn) return { ok: false, reason: "flag_off" };
  if (!consent || !Array.isArray(consent.retailers) || !consent.retailers.includes(retailer)) {
    return { ok: false, reason: "no_consent" };
  }
  if (consent.copy_version !== consentVersion) return { ok: false, reason: "stale_consent" };
  return { ok: true };
}

export interface Tier3Gate {
  isTier3Allowed(householdId: string, retailer: string): Promise<Tier3Decision>;
  tier3Gate(householdId: string, retailer: string): Promise<void>;
}

export function createTier3Gate(deps: Tier3GateDeps): Tier3Gate {
  async function isTier3Allowed(householdId: string, retailer: string): Promise<Tier3Decision> {
    if (!isTier3Retailer(retailer)) {
      throw new RetailerNotSupportedError(null, "tier3", `${retailer} is not a Tier 3 retailer`);
    }
    let flagOn = true;
    try {
      flagOn = await deps.isFlagOn(retailer);
    } catch {
      // A kill switch that cannot be read is not pulled.
      flagOn = true;
    }
    if (!flagOn) return { ok: false, reason: "flag_off" };
    const consent = await deps.readConsent(householdId);
    return decideTier3(retailer, true, consent, deps.consentVersion);
  }

  return {
    isTier3Allowed,
    async tier3Gate(householdId, retailer) {
      const decision = await isTier3Allowed(householdId, retailer);
      if (!decision.ok) throw new Tier3GateError(retailer as Tier3RetailerId, decision.reason);
    },
  };
}

// ---------------------------------------------------------------------------------------
// The configured gate. The app calls configureTier3Gate once at start-up; tests build their own
// with createTier3Gate.
// ---------------------------------------------------------------------------------------

let configured: Tier3Gate | null = null;

export function configureTier3Gate(deps: Tier3GateDeps | null): void {
  configured = deps ? createTier3Gate(deps) : null;
}

function current(): Tier3Gate {
  if (!configured) {
    throw new RetailerNotSupportedError(null, "tier3", "The Tier 3 gate is not configured");
  }
  return configured;
}

export async function isTier3Allowed(
  householdId: string,
  retailer: string,
): Promise<Tier3Decision> {
  return current().isTier3Allowed(householdId, retailer);
}

/** Resolves when this household may drive this retailer's site now; throws Tier3GateError if not. */
export async function tier3Gate(householdId: string, retailer: string): Promise<void> {
  return current().tier3Gate(householdId, retailer);
}

/**
 * Wires the gate into a registry for one household. The registry's hook is synchronous, so every
 * Tier 3 retailer is decided here first, then the registry refuses those that failed. Call it
 * again before each run (a flag or a consent may have changed); the returned function removes the
 * hook. Retailers that are not Tier 3 pass through untouched.
 */
export async function installTier3Gate(
  householdId: string,
  gate: Tier3Gate = current(),
  registry: AdapterRegistry = defaultRegistry,
): Promise<() => void> {
  const decisions = new Map<Tier3RetailerId, Tier3Decision>();
  for (const id of TIER3_RETAILER_IDS) {
    decisions.set(id, await gate.isTier3Allowed(householdId, id));
  }
  const hook = (id: RetailerId) => {
    if (!isTier3Retailer(id)) return;
    const decision = decisions.get(id) ?? { ok: false, reason: "no_consent" };
    if (!decision.ok) throw new Tier3GateError(id, decision.reason);
  };
  registry.setGate(hook);
  return () => {
    if (registry.getGate() === hook) registry.setGate(null);
  };
}

/** The async path: checks the gate for this household, then asks the registry for the adapter. */
export async function getGatedAdapter(
  householdId: string,
  retailer: RetailerId,
  gate: Tier3Gate = current(),
  registry: AdapterRegistry = defaultRegistry,
): Promise<RetailerAdapter> {
  if (isTier3Retailer(retailer)) await gate.tier3Gate(householdId, retailer);
  return registry.getAdapter(retailer);
}
