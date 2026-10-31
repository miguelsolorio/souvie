// The Tier 3 consent copy, approved by Miguel at checkpoint 4 on 2026-10-31 (docs/08-brand.md §11),
// verbatim. `{store}` is filled at render time with the display name of the banner being connected.
// consent.test.ts compares this file with docs/08 §11, so the two cannot drift apart.
//
// Changing a word here is a new copy version: bump CONSENT_VERSION, and every household is asked
// again the next time it connects (and tier3Gate refuses runs until it has). The database holds the
// same value in public.tier3_consent_version(), which connect_browser_session checks; bump it in a
// new migration in the same change (llm-proxy/tier3-sql.test.ts and the pgTAP file compare them).
import { TIER3_RETAILER_IDS, type Tier3Consent, type Tier3RetailerId } from "@mp/retailers";

export const CONSENT_VERSION = "2026-10-31";

/** The retailer ids consent is recorded for: ["safeway", "costco"]. */
export const TIER3_RETAILERS: readonly Tier3RetailerId[] = TIER3_RETAILER_IDS;

export interface ConsentSection {
  heading: string;
  body: string;
}

export interface ConsentCopy {
  title: string;
  sections: ConsentSection[];
  acknowledgment: string;
}

export const CONSENT_COPY: Readonly<ConsentCopy> = Object.freeze({
  title: "Before Souvie shops at {store}",
  sections: [
    {
      heading: "How this works",
      body: "Souvie opens {store}'s own website inside this app and shops as you, on your phone, while you watch. You sign in to {store} yourself, on their page. The agent searches, adds items to your cart, and picks a pickup or delivery slot when the site offers one. It stops at the pay button. You tap it. Nothing is bought without your tap unless you later turn on auto-checkout under a spending cap in Settings.",
    },
    {
      heading: "What {store}'s terms say",
      body: "Costco's terms bar software that interacts with its services without Costco's written consent, and say the member is responsible for the account. Safeway, Albertsons and Haggen share one set of terms that bar access other than through their visual interface, any automated system, and commercial use without approval. Souvie has none of these approvals. You are the one shopping, on your own device and account, with an assistant that works the page for you. Still, {store} could treat this as a breach of its terms and lock or close your account. That risk is yours, and we want you to know it before you continue.",
    },
    {
      heading: "What we store, and what we never store",
      body: "We never see, store or send your {store} password. You type it on {store}'s page. After you sign in, Souvie keeps your session (the cookies and site data a browser keeps) encrypted on this phone, with a key held in our server vault that only you can fetch. That is what lets the agent shop without asking you to sign in every time. The encrypted session never leaves your phone. Souvie keeps a screenshot of each step the agent takes for 30 days so you and your household can see exactly what it did; then they are deleted.",
    },
    {
      heading: "Stopping and disconnecting",
      body: "Disconnect {store} any time in Settings. That clears the session from this phone and deletes the key from our vault. Your {store} account itself is untouched; sign out there too if you want to end the session on their side. If {store} shows a sign-in page, a verification puzzle, or a one-time code, the agent stops and hands the phone to you. We can also switch off shopping at any store for everyone if a store objects or something breaks.",
    },
    {
      heading: "Personal use only",
      body: "This is for your household's own groceries. Do not use it to shop for a business or for resale. Costco requires an active membership; the agent cannot shop there without one.",
    },
  ],
  acknowledgment:
    "I understand that Souvie will shop at {store} as me, on my device, that this may conflict with {store}'s terms and could affect my account, that my password is never stored, and that the agent stops at the pay button.",
});

/** The copy with `{store}` filled in. */
export function renderConsentCopy(storeName: string): ConsentCopy {
  const fill = (s: string) => s.split("{store}").join(storeName);
  return {
    title: fill(CONSENT_COPY.title),
    sections: CONSENT_COPY.sections.map((s) => ({ heading: fill(s.heading), body: fill(s.body) })),
    acknowledgment: fill(CONSENT_COPY.acknowledgment),
  };
}

/**
 * Whether connecting this retailer must show the consent screen first: yes when the household has
 * no consent, when its consent does not name the retailer, or when it was given for an older copy
 * version. A household that already consented for this retailer at this version skips it.
 */
export function needsConsent(
  consent: Tier3Consent | null | undefined,
  retailer: Tier3RetailerId,
  version: string = CONSENT_VERSION,
): boolean {
  if (!consent || !Array.isArray(consent.retailers)) return true;
  return !consent.retailers.includes(retailer) || consent.copy_version !== version;
}

/** Reads `households.tier3_consent` as stored, or null when it is missing or malformed. */
export function parseConsent(value: unknown): Tier3Consent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.accepted_at !== "string" ||
    typeof v.by_user_id !== "string" ||
    typeof v.copy_version !== "string" ||
    !Array.isArray(v.retailers) ||
    !v.retailers.every((r) => typeof r === "string")
  ) {
    return null;
  }
  return {
    accepted_at: v.accepted_at,
    by_user_id: v.by_user_id,
    copy_version: v.copy_version,
    retailers: v.retailers as string[],
  };
}
