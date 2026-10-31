// A Tier 3 session through one run (WS08). The lifecycle (docs/04 §Tier 3, brief §Session lifecycle):
//
//   connect      the person signs in on the retailer's page; signedIn() saves the session
//   run starts   restore(): the encrypted blob is decrypted and its cookies written into the
//                WebView's store before the first navigation; restoreScript puts the origin's
//                storage back on the first document
//   run ends     save({ clear: true }): saved again if anything changed, then the retailer's
//                cookies and the page's storage are cleared, so nothing stays in plaintext
//   backgrounded the hook saves (without clearing; the run may resume)
//   expired      the bridge raises `login`; the person signs in again and the blob is replaced
//   disconnect   wipeSession (secureSession.ts)
import { findByRole, type SnapshotTree, type Tier3RetailerId } from "@mp/retailers";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import { type BridgeHost, hostAllowed } from "./bridgeHost";
import {
  appSessionVault,
  type CookieJar,
  RESTORE_MARKER_PREFIX,
  type SessionState,
  SessionUnavailableError,
  type SessionVault,
  sanitizeSession,
} from "./secureSession";
import { isAllowedCookieDomain, RETAILER_SESSION_DOMAINS } from "./stores";

export interface SessionTarget {
  connectionId: string;
  retailer: Tier3RetailerId;
}

export interface Tier3SessionDeps {
  vault: SessionVault;
  cookies: CookieJar;
  now?: () => Date;
}

export type RestoreResult =
  | { status: "restored"; state: SessionState; restoreScript: string | null }
  | { status: "needs_sign_in" }
  | { status: "unavailable" };

/**
 * JavaScript for injectedJavaScriptBeforeContentLoaded that puts the saved storage back on the
 * session's own origin, once per run (the run token marks it done in sessionStorage).
 */
export function buildStorageRestoreScript(state: SessionState, runToken: string): string | null {
  if (!state.origin) return null;
  const hasStorage =
    Object.keys(state.localStorage).length > 0 || Object.keys(state.sessionStorage).length > 0;
  if (!hasStorage) return null;
  const marker = `${RESTORE_MARKER_PREFIX}${runToken.replace(/[^A-Za-z0-9]/g, "")}`;
  return [
    "(function(){try{",
    `if(location.origin!==${JSON.stringify(state.origin)})return;`,
    `var m=${JSON.stringify(marker)};`,
    'if(sessionStorage.getItem(m)==="1")return;',
    `var l=${JSON.stringify(state.localStorage)},s=${JSON.stringify(state.sessionStorage)},k;`,
    "for(k in l){if(Object.prototype.hasOwnProperty.call(l,k))localStorage.setItem(k,l[k]);}",
    "for(k in s){if(Object.prototype.hasOwnProperty.call(s,k))sessionStorage.setItem(k,s[k]);}",
    'sessionStorage.setItem(m,"1");',
    "}catch(e){}})();true;",
  ].join("");
}

/** What a session amounts to, without its timestamp: two equal fingerprints need no new save. */
export function sessionFingerprint(state: SessionState): string {
  const cookies = [...state.cookies]
    .map((c) => JSON.stringify([c.domain, c.path, c.name, c.value, c.expires ?? ""]))
    .sort();
  const sorted = (m: Record<string, string>) =>
    Object.keys(m)
      .sort()
      .map((k) => [k, m[k]]);
  return JSON.stringify([
    state.origin,
    cookies,
    sorted(state.localStorage),
    sorted(state.sessionStorage),
  ]);
}

const SIGNIN_PATH = /(^|[/_.-])(sign[-_]?in|log[-_]?in|logon|signon|authenticate)([/_.?#-]|$)/i;
const ACCOUNT_NAME =
  /^(?:account|my account|your account|sign out|log ?out|profile|hi,? .+|welcome,? .+)$|\b(?:sign out|log ?out|my account)\b/i;

/**
 * Whether the page reads as signed in: not on a sign-in URL, no password field, and an account
 * menu or sign-out control on screen. Generic on purpose; WS10's site recipes can pass their own.
 */
export function looksSignedIn(tree: SnapshotTree, url: string): boolean {
  let path = "";
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  if (SIGNIN_PATH.test(path)) return false;
  if (findByRole(tree, "textbox", /password/i).length > 0) return false;
  return (
    findByRole(tree, "button", ACCOUNT_NAME).length > 0 ||
    findByRole(tree, "link", ACCOUNT_NAME).length > 0 ||
    findByRole(tree, "menuitem", ACCOUNT_NAME).length > 0
  );
}

export interface Tier3Session {
  readonly target: SessionTarget;
  restore(runToken: string): Promise<RestoreResult>;
  capture(host: BridgeHost): Promise<SessionState>;
  /** Saves when the session changed. `clear` also wipes the plaintext copy from the WebView. */
  save(host: BridgeHost, opts?: { clear?: boolean }): Promise<"saved" | "unchanged">;
  /** First save after sign-in. Always writes. */
  signedIn(host: BridgeHost): Promise<void>;
}

export function createTier3Session(target: SessionTarget, deps: Tier3SessionDeps): Tier3Session {
  const domains = RETAILER_SESSION_DOMAINS[target.retailer];
  const now = deps.now ?? (() => new Date());
  let lastSaved: string | null = null;

  async function capture(host: BridgeHost): Promise<SessionState> {
    const cookies = (await deps.cookies.read(domains)).filter((c) =>
      isAllowedCookieDomain(c.domain, domains),
    );
    let storage = { origin: "", localStorage: {}, sessionStorage: {} } as {
      origin: string;
      localStorage: Record<string, string>;
      sessionStorage: Record<string, string>;
    };
    try {
      const dump = await host.readStorage();
      // Storage is kept only when the page is on the retailer's own site.
      if (hostAllowed(dump.origin, domains)) storage = dump;
    } catch {
      // No bridge on the page right now: cookies alone still carry the session.
    }
    return sanitizeSession({
      cookies,
      localStorage: storage.localStorage,
      sessionStorage: storage.sessionStorage,
      savedAt: now().toISOString(),
      origin: storage.origin,
    });
  }

  async function write(state: SessionState) {
    await deps.vault.saveSession(target.connectionId, state);
    lastSaved = sessionFingerprint(state);
  }

  return {
    target,

    async restore(runToken) {
      let state: SessionState | null;
      try {
        state = await deps.vault.loadSession(target.connectionId);
      } catch (err) {
        if (err instanceof SessionUnavailableError) return { status: "unavailable" };
        throw err;
      }
      if (!state) return { status: "needs_sign_in" };
      await deps.cookies.write(
        state.cookies.filter((c) => isAllowedCookieDomain(c.domain, domains)),
      );
      lastSaved = sessionFingerprint(state);
      return {
        status: "restored",
        state,
        restoreScript: buildStorageRestoreScript(state, runToken),
      };
    },

    capture,

    async save(host, opts) {
      const state = await capture(host);
      let result: "saved" | "unchanged" = "unchanged";
      if (sessionFingerprint(state) !== lastSaved) {
        await write(state);
        result = "saved";
      }
      if (opts?.clear) {
        await deps.cookies.clearDomains(domains);
        host.clearPageStorage();
        deps.vault.forgetKeys();
      }
      return result;
    },

    async signedIn(host) {
      await write(await capture(host));
    },
  };
}

// ---------------------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------------------

export type Tier3SessionStatus =
  | "idle"
  | "restoring"
  | "ready"
  | "needs_sign_in"
  | "unavailable"
  | "saving"
  | "error";

/** The device deps: the app vault and the WebView cookie store. Not for tests. */
export function appTier3SessionDeps(): Tier3SessionDeps {
  const { nativeCookieJar } = require("./nativeSession") as typeof import("./nativeSession");
  return { vault: appSessionVault(), cookies: nativeCookieJar };
}

/**
 * The session for one connection while a screen drives it. Call `restore(runToken)` before the
 * WebView's first navigation, `attach(host)` once the WebView is up, and `save({ clear: true })`
 * when the run ends. Backgrounding the app saves on its own.
 */
export function useTier3Session(target: SessionTarget | null, deps?: Tier3SessionDeps) {
  const connectionId = target?.connectionId ?? null;
  const retailer = target?.retailer ?? null;
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const session = useMemo(
    () =>
      connectionId && retailer
        ? createTier3Session({ connectionId, retailer }, depsRef.current ?? appTier3SessionDeps())
        : null,
    [connectionId, retailer],
  );
  const hostRef = useRef<BridgeHost | null>(null);
  const [status, setStatus] = useState<Tier3SessionStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const restore = useCallback(
    async (runToken: string): Promise<RestoreResult | null> => {
      if (!session) return null;
      setStatus("restoring");
      try {
        const result = await session.restore(runToken);
        setStatus(result.status === "restored" ? "ready" : result.status);
        return result;
      } catch (err) {
        setStatus("error");
        setError(err instanceof Error ? err.message : String(err));
        return null;
      }
    },
    [session],
  );

  const attach = useCallback((host: BridgeHost | null) => {
    hostRef.current = host;
  }, []);

  const save = useCallback(
    async (opts?: { clear?: boolean }) => {
      const host = hostRef.current;
      if (!session || !host) return null;
      setStatus("saving");
      try {
        const result = await session.save(host, opts);
        setStatus("ready");
        return result;
      } catch (err) {
        setStatus(err instanceof SessionUnavailableError ? "unavailable" : "error");
        setError(err instanceof Error ? err.message : String(err));
        return null;
      }
    },
    [session],
  );

  useEffect(() => {
    if (!session) return;
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "background" && hostRef.current) void save();
    });
    return () => sub.remove();
  }, [session, save]);

  return { session, status, error, restore, attach, save };
}
