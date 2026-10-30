// The Kroger OAuth redirect, souvie://oauth/kroger?code=...&state=... (docs/01 §Deep links).
//
// Two paths can see it: the auth session that opened the browser (iOS, and Android while the app
// stays alive), and the oauth/kroger route (Android cold start, or a session that lost its
// promise). A code works once, so both go through completeKrogerRedirect, which handles each
// redirect a single time.
import type { MpClient } from "@mp/db";
import type { Modality, Store } from "@mp/retailers";
import { exchangeKrogerCode, RetailerApiError, type RetailerConnection } from "./api";

export const KROGER_REDIRECT_PATH = "oauth/kroger";
/**
 * The redirect registered with Kroger and set as KROGER_REDIRECT_URI on the function. A literal,
 * not Linking.createURL: Expo Go would build an exp:// URL that Kroger does not know, so the
 * Connect flow needs a development build.
 */
export const KROGER_REDIRECT_URI = `souvie://${KROGER_REDIRECT_PATH}`;

export type KrogerRedirect =
  | { kind: "code"; code: string; state: string }
  | { kind: "error"; error: string; description: string | null }
  | { kind: "invalid" };

function decode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

/** Query parameters, first value wins. Hand-parsed because Hermes' URL class is incomplete. */
function queryOf(url: string): Map<string, string> {
  const hashAt = url.indexOf("#");
  const beforeHash = hashAt === -1 ? url : url.slice(0, hashAt);
  const queryAt = beforeHash.indexOf("?");
  const pairs = new Map<string, string>();
  if (queryAt === -1) return pairs;
  for (const part of beforeHash.slice(queryAt + 1).split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const key = decode(eq === -1 ? part : part.slice(0, eq));
    if (!pairs.has(key)) pairs.set(key, eq === -1 ? "" : decode(part.slice(eq + 1)));
  }
  return pairs;
}

/** Reads a Kroger redirect URL without trusting anything else in it. */
export function parseKrogerRedirect(url: string): KrogerRedirect {
  if (!url.startsWith(KROGER_REDIRECT_URI)) return { kind: "invalid" };
  const query = queryOf(url);
  const error = query.get("error");
  if (error) return { kind: "error", error, description: query.get("error_description") ?? null };
  const code = query.get("code");
  const state = query.get("state");
  if (!code || !state || code.length > 4096 || state.length > 4096) return { kind: "invalid" };
  return { kind: "code", code, state };
}

/** Rebuilds the redirect from route params, for the oauth/kroger screen. */
export function redirectFromParams(params: Record<string, string | string[] | undefined>): string {
  const parts: string[] = [];
  for (const key of ["code", "state", "error", "error_description"]) {
    const value = params[key];
    if (typeof value === "string" && value.length > 0) {
      parts.push(`${key}=${encodeURIComponent(value)}`);
    }
  }
  return `${KROGER_REDIRECT_URI}?${parts.join("&")}`;
}

/** What the person picked before connecting, carried to the exchange. Memory only. */
let pendingChoice: { store: Pick<Store, "id" | "name"> | null; modality: Modality | null } = {
  store: null,
  modality: null,
};

export function rememberConnectChoice(
  store: Pick<Store, "id" | "name"> | null,
  modality: Modality | null,
): void {
  pendingChoice = { store, modality };
}

const inflight = new Map<string, Promise<RetailerConnection>>();

/**
 * Exchanges the code in a Kroger redirect for a stored connection. Calling it twice with the same
 * redirect returns the same promise, so the auth session and the route never both spend the code.
 */
export function completeKrogerRedirect(client: MpClient, url: string): Promise<RetailerConnection> {
  const redirect = parseKrogerRedirect(url);
  if (redirect.kind === "error") {
    const cancelled = redirect.error === "access_denied";
    return Promise.reject(
      new RetailerApiError(
        redirect.error,
        cancelled
          ? "Kroger sign-in was cancelled."
          : (redirect.description ?? "Kroger did not finish the sign-in."),
      ),
    );
  }
  if (redirect.kind === "invalid") {
    return Promise.reject(
      new RetailerApiError("invalid_request", "This Kroger sign-in link is missing its code."),
    );
  }
  const existing = inflight.get(redirect.code);
  if (existing) return existing;
  const { store, modality } = pendingChoice;
  const promise = exchangeKrogerCode(client, {
    code: redirect.code,
    state: redirect.state,
    store,
    modality,
  });
  inflight.set(redirect.code, promise);
  return promise;
}

/** For tests. */
export function resetKrogerRedirects(): void {
  inflight.clear();
  pendingChoice = { store: null, modality: null };
}
