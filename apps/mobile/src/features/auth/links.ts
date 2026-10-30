// Pure helpers for deep links and invite links. No React Native imports, so Vitest can run them.

/** Invite tokens are 64 hex characters today. Accept any URL-safe token of a sane length. */
const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export function isValidInviteToken(value: unknown): value is string {
  return typeof value === "string" && INVITE_TOKEN_PATTERN.test(value);
}

/**
 * Pulls an invite token out of whatever a person pastes: the bare token, an https link ending in
 * /join/<token>, or the souvie://join/<token> deep link. Returns null for anything else.
 */
export function parseInviteInput(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  if (isValidInviteToken(text)) return text;
  const match = /\/join\/([A-Za-z0-9_-]+)\/?(?:[?#].*)?$/.exec(text);
  const token = match?.[1];
  return isValidInviteToken(token) ? token : null;
}

/**
 * The link an owner shares. With a web origin it is https://<origin>/join/<token>, which opens
 * the web app or, once universal links exist, the native app. Without one, the deep link.
 */
export function buildInviteUrl(token: string, webOrigin?: string | null): string {
  const origin = webOrigin?.trim().replace(/\/+$/, "");
  return origin ? `${origin}/join/${token}` : `souvie://join/${token}`;
}

export interface AuthCallbackParams {
  code: string | null;
  error: string | null;
  errorDescription: string | null;
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

function parsePairs(text: string): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const part of text.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const key = decode(eq === -1 ? part : part.slice(0, eq));
    const value = eq === -1 ? "" : decode(part.slice(eq + 1));
    if (!pairs.has(key)) pairs.set(key, value);
  }
  return pairs;
}

/**
 * Reads the result of a sign-in redirect from a URL. With PKCE the success case is
 * `?code=<code>`. Failures arrive as `error` and `error_description`, in the query or, for
 * expired magic links, in the #fragment. Hand-parsed because Hermes' URL class is incomplete.
 */
export function parseAuthCallback(url: string): AuthCallbackParams {
  const hashAt = url.indexOf("#");
  const beforeHash = hashAt === -1 ? url : url.slice(0, hashAt);
  const fragment = hashAt === -1 ? "" : url.slice(hashAt + 1);
  const queryAt = beforeHash.indexOf("?");
  const query = queryAt === -1 ? "" : beforeHash.slice(queryAt + 1);

  const fromQuery = parsePairs(query);
  const fromFragment = parsePairs(fragment);
  const pick = (key: string): string | null => fromQuery.get(key) ?? fromFragment.get(key) ?? null;

  return {
    code: pick("code") || null,
    error: pick("error") || pick("error_code") || null,
    errorDescription: pick("error_description") || null,
  };
}
