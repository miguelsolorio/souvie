// What may leave the app in an error event (docs/05 §Privacy, §Audit). Sentry gets the failure,
// the household id and the release. It never gets an email, a token, a cookie, a password, a key,
// or a query string, and the app never sends a prompt, a model answer, a recipe or a shopping
// list (Risks and notes, WS15 brief). This file is the last line of defense: every event passes
// through `scrubEvent` in Sentry's beforeSend, whatever put the text there.
//
// What this file does not know: a product name, a street address, a list line or a search term.
// They are kept out by what callers send (ids, counts and short codes, and per-event key
// allowlists for analytics), not by a pattern here. The app sends no spans (tracesSampleRate 0).
//
// Pure functions, no imports. This is a copy of services/shopper-worker/src/observability/scrub.ts
// (the app and the worker share no package they may both edit); the worker's scrub.test.ts runs
// the same cases against all three files and compares their code, so the copies cannot drift apart.

export const FILTERED = "[Filtered]";

/**
 * Keys whose values are never sent, at any depth. A key that ends in query or query_string
 * (url.query, query_string) holds a query string, and its first parameter has no ? or & in front
 * of it for QUERY_VALUE to find, so the whole value goes.
 */
const SENSITIVE_KEY =
  /^(authorization|proxy-authorization|cookie|cookies|set-cookie|dsn|x-api-key)$|(token|secret|password|passwd|apikey|api[-_]key|credentials?|e-?mail)$|(?:^|[._-])query(?:[._-]?string)?$/i;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
/** "Basic dXNlcjpwYXNz": the base64 of user:password. Also matches an English "Basic" before a word of 8 letters or more. */
const BASIC = /\bBasic\s+[A-Za-z0-9+/]{8,}={0,2}/g;
/** A Cookie or Set-Cookie header line inside a string, through the end of that line. */
const COOKIE_LINE = /\b(set-cookie|cookie)\s*:[^\r\n]*/gi;
/**
 * A US phone number: (555) 123-4567, 555-123-4567, 555.123.4567, 555 123 4567, +1 555 123 4567,
 * 1-555-123-4567 and a bare run of ten digits. A longer digit run (an id, a timestamp in
 * milliseconds, a UUID group) is not a phone number. Numbers from other countries are not matched.
 */
const PHONE = /(?<![\w.])(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-]?)\d{3}[\s.-]?\d{4}(?!\w)/g;
/** Key shapes we handle: Anthropic, Supabase access and service keys, PostHog, Sentry, Expo, GitHub. */
const KNOWN_KEYS =
  /\b(?:sk-ant-[A-Za-z0-9_-]{8,}|sbp_[A-Za-z0-9]{12,}|sb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}|ph[cx]_[A-Za-z0-9]{12,}|sntrys_[A-Za-z0-9+/=_-]{12,}|ExponentPushToken\[[^\]]+\]|gh[pousr]_[A-Za-z0-9]{20,})/g;
/** A DSN carries its public key before the @: https://<key>@o123.ingest.sentry.io/456. */
const DSN = /https?:\/\/[A-Za-z0-9]+(?::[A-Za-z0-9]+)?@[A-Za-z0-9.-]*sentry[A-Za-z0-9.-]*\/\d+/g;
/** postgres://user:password@host/db */
const DB_URL = /\b(?:postgres(?:ql)?|mysql|redis):\/\/[^\s'"]+/gi;
/** Values in a URL query string: a token or an address can ride there. */
const QUERY_VALUE = /([?&][^=&#\s'"]+)=([^&#\s'"]*)/g;

/** A string with every emailish, tokenish, cookieish and credentialish part replaced by [Filtered]. */
export function scrubString(text: string): string {
  return text
    .replace(COOKIE_LINE, `$1: ${FILTERED}`)
    .replace(DB_URL, FILTERED)
    .replace(DSN, FILTERED)
    .replace(JWT, FILTERED)
    .replace(BEARER, `Bearer ${FILTERED}`)
    .replace(BASIC, `Basic ${FILTERED}`)
    .replace(KNOWN_KEYS, FILTERED)
    .replace(EMAIL, FILTERED)
    .replace(PHONE, FILTERED)
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

/** Span attributes that are about a URL or an HTTP exchange: url, url.*, http.*. */
const URL_OR_HTTP_KEY = /^(?:url|http)(?:\.|$)/;
/** Of those, the ones that stay: the method, the status code, the scheme and the host. */
const KEPT_URL_OR_HTTP_KEY =
  /^(?:http\.(?:request\.method(?:_original)?|method|response\.status_code|status_code)|url\.(?:scheme|domain))$/;
/** Of those, the ones that hold a whole URL. They stay without userinfo, query and fragment. */
const WHOLE_URL_KEY = /^(?:url|url\.full|http\.url)$/;
/** Who was on the other end of a connection: an address and a port. */
const PEER_KEY = /^(?:client\.(?:address|port)|network\.(?:peer|local)\.(?:address|port))$/;

/** A URL cut at its query or fragment, without the user and password in front of the host. */
export function stripUrl(url: string): string {
  const cut = url.search(/[?#]/);
  const head = cut === -1 ? url : url.slice(0, cut);
  return head.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@\s]*@/, "$1");
}

/**
 * The attributes of a span as they may be sent. Every url.* and http.* attribute is dropped except
 * the method, the status code, the scheme and the host (url.domain, and server.address which is
 * not in those families); a whole URL (url.full, http.url) stays without its query, fragment and
 * credentials. That removes url.query, url.path, http.target, http.query and every request and
 * response header. The address and port of the peer are dropped. The rest goes through
 * `scrubValue`.
 */
export function scrubSpanData(data: unknown): unknown {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return data;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (PEER_KEY.test(key)) continue;
    if (URL_OR_HTTP_KEY.test(key)) {
      if (KEPT_URL_OR_HTTP_KEY.test(key)) out[key] = scrubValue(value);
      else if (WHOLE_URL_KEY.test(key) && typeof value === "string") {
        out[key] = scrubString(stripUrl(value));
      }
      continue;
    }
    out[key] = SENSITIVE_KEY.test(key) ? FILTERED : scrubValue(value);
  }
  return out;
}

/** A breadcrumb as it may be sent: every string scrubbed, and its data like the attributes of a span. */
export function scrubBreadcrumb<T extends Record<string, unknown>>(breadcrumb: T): T {
  const next = scrubValue(breadcrumb) as Record<string, unknown>;
  if (breadcrumb.data !== null && typeof breadcrumb.data === "object") {
    next.data = scrubSpanData(breadcrumb.data);
  }
  return next as T;
}

/** A finished span in the static format (@sentry/core's SpanJSON), typed loosely. */
export interface SpanLike {
  data?: unknown;
  description?: string;
  name?: string;
  [key: string]: unknown;
}

/** A span as it may be sent: its attributes by `scrubSpanData`, its name and description scrubbed. */
export function scrubSpan<T extends SpanLike>(span: T): T {
  const next: SpanLike = { ...span };
  if (next.data) next.data = scrubSpanData(next.data);
  if (typeof next.description === "string") next.description = scrubString(next.description);
  if (typeof next.name === "string") next.name = scrubString(next.name);
  return next as T;
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
  transaction?: string;
  spans?: unknown;
  exception?: { values?: Array<{ value?: string } & Record<string, unknown>> };
  [key: string]: unknown;
}

function scrubBreadcrumbs(breadcrumbs: unknown[]): unknown[] {
  return breadcrumbs.map((item) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? scrubBreadcrumb(item as Record<string, unknown>)
      : scrubValue(item),
  );
}

/** The contexts of an event; the attributes of a transaction's root span (contexts.trace.data) go through `scrubSpanData`. */
function scrubContexts(contexts: unknown): unknown {
  const out = scrubValue(contexts);
  const trace = (contexts as { trace?: { data?: unknown } } | null)?.trace;
  if (out && typeof out === "object" && trace && typeof trace === "object" && "data" in trace) {
    const scrubbed = out as { trace: Record<string, unknown> };
    scrubbed.trace = { ...scrubbed.trace, data: scrubSpanData(trace.data) };
  }
  return out;
}

/**
 * The event as it may be sent: no user (the household id is a tag, nothing about the person),
 * no request body, headers, cookies or query string, no host name, every string scrubbed, and a
 * transaction's spans and root span attributes through `scrubSpanData`. Tags keep their keys, so
 * `household_id`, `run_id` and `release` survive; their values are scrubbed like any string.
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
  if (typeof next.transaction === "string") next.transaction = scrubString(next.transaction);
  if (next.logentry) next.logentry = scrubValue(next.logentry);
  if (next.extra) next.extra = scrubValue(next.extra);
  if (next.contexts) next.contexts = scrubContexts(next.contexts);
  if (next.tags) next.tags = scrubValue(next.tags);
  if (Array.isArray(next.spans)) next.spans = next.spans.map((span) => scrubSpan(span as SpanLike));
  if (Array.isArray(next.breadcrumbs)) next.breadcrumbs = scrubBreadcrumbs(next.breadcrumbs);
  else if (next.breadcrumbs && typeof next.breadcrumbs === "object") {
    const values = (next.breadcrumbs as { values?: unknown }).values;
    next.breadcrumbs = { values: scrubBreadcrumbs(Array.isArray(values) ? values : []) };
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
