// What may leave the app in an error event (docs/05 §Privacy, §Audit). Sentry gets the failure,
// the household id and the release. It never gets an email, a token, a cookie, a password, a key,
// or a query string, and the app never sends a prompt, a model answer, a recipe or a shopping
// list (Risks and notes, WS15 brief). This file is the last line of defense: every event passes
// through `scrubEvent` in Sentry's beforeSend, whatever put the text there.
//
// Pure functions, no imports. This is a copy of services/shopper-worker/src/observability/scrub.ts
// (the app and the worker share no package they may both edit); the worker's scrub.test.ts runs
// the same cases against both files, so the two cannot drift apart.

export const FILTERED = "[Filtered]";

/** Keys whose values are never sent, at any depth. */
const SENSITIVE_KEY =
  /^(authorization|proxy-authorization|cookie|cookies|set-cookie|dsn|x-api-key)$|(token|secret|password|passwd|apikey|api[-_]key|credentials?|e-?mail)$/i;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
/** Key shapes we handle: Anthropic, Supabase access and service keys, PostHog, Sentry, Expo, GitHub. */
const KNOWN_KEYS =
  /\b(?:sk-ant-[A-Za-z0-9_-]{8,}|sbp_[A-Za-z0-9]{12,}|sb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}|ph[cx]_[A-Za-z0-9]{12,}|sntrys_[A-Za-z0-9+/=_-]{12,}|ExponentPushToken\[[^\]]+\]|gh[pousr]_[A-Za-z0-9]{20,})/g;
/** A DSN carries its public key before the @: https://<key>@o123.ingest.sentry.io/456. */
const DSN = /https?:\/\/[A-Za-z0-9]+(?::[A-Za-z0-9]+)?@[A-Za-z0-9.-]*sentry[A-Za-z0-9.-]*\/\d+/g;
/** postgres://user:password@host/db */
const DB_URL = /\b(?:postgres(?:ql)?|mysql|redis):\/\/[^\s'"]+/gi;
/** Values in a URL query string: a token or an address can ride there. */
const QUERY_VALUE = /([?&][^=&#\s'"]+)=([^&#\s'"]*)/g;

/** A string with every emailish, tokenish and credentialish part replaced by [Filtered]. */
export function scrubString(text: string): string {
  return text
    .replace(DB_URL, FILTERED)
    .replace(DSN, FILTERED)
    .replace(JWT, FILTERED)
    .replace(BEARER, `Bearer ${FILTERED}`)
    .replace(KNOWN_KEYS, FILTERED)
    .replace(EMAIL, FILTERED)
    .replace(QUERY_VALUE, `$1=${FILTERED}`);
}

const MAX_DEPTH = 8;

/** Walks a value: sensitive keys lose their value, strings are scrubbed, depth is bounded. */
export function scrubValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return scrubString(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return FILTERED;
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? FILTERED : scrubValue(inner, depth + 1);
  }
  return out;
}

/** The parts of a Sentry event this file touches, typed loosely so any SDK's event fits. */
export interface EventLike {
  user?: unknown;
  request?: unknown;
  server_name?: string;
  extra?: unknown;
  contexts?: unknown;
  breadcrumbs?: unknown;
  tags?: unknown;
  message?: string;
  logentry?: unknown;
  exception?: { values?: Array<{ value?: string } & Record<string, unknown>> };
  [key: string]: unknown;
}

/**
 * The event as it may be sent: no user (the household id is a tag, nothing about the person),
 * no request body, headers, cookies or query string, no host name, and every string scrubbed.
 * Tags keep their keys, so `household_id`, `run_id` and `release` survive; their values are
 * scrubbed like any string.
 */
export function scrubEvent<T extends EventLike>(event: T): T {
  const next: EventLike = { ...event };
  delete next.user;
  delete next.server_name;
  if (next.request && typeof next.request === "object") {
    const { url, method } = next.request as { url?: unknown; method?: unknown };
    next.request = {
      ...(typeof method === "string" ? { method } : {}),
      ...(typeof url === "string" ? { url: scrubString(url.split("?")[0] ?? "") } : {}),
    };
  }
  if (typeof next.message === "string") next.message = scrubString(next.message);
  if (next.logentry) next.logentry = scrubValue(next.logentry);
  if (next.extra) next.extra = scrubValue(next.extra);
  if (next.contexts) next.contexts = scrubValue(next.contexts);
  if (next.tags) next.tags = scrubValue(next.tags);
  if (Array.isArray(next.breadcrumbs)) next.breadcrumbs = scrubValue(next.breadcrumbs);
  else if (next.breadcrumbs && typeof next.breadcrumbs === "object") {
    const values = (next.breadcrumbs as { values?: unknown }).values;
    next.breadcrumbs = { values: scrubValue(values ?? []) };
  }
  if (next.exception?.values) {
    next.exception = {
      ...next.exception,
      values: next.exception.values.map((entry) => ({
        ...entry,
        ...(typeof entry.value === "string" ? { value: scrubString(entry.value) } : {}),
      })),
    };
  }
  return next as T;
}
