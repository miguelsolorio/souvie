// Tier 3 sessions on the device (WS08, docs/05 §Retailer credentials and sessions).
//
// After the person signs in on the retailer's own page in the WebView, the app keeps the session
// (cookies for the retailer's own domains, plus that origin's localStorage and sessionStorage) and
// nothing else. It is encrypted with AES-256-GCM under a per-connection key held in Supabase Vault,
// fetched with connection_session_key, kept in memory for the run, and never written to disk. The
// ciphertext lives in expo-secure-store under the connection id. It never leaves the phone; no
// server ever sees it.
//
// No password is ever read, stored or autofilled: the bridge never serializes a password field,
// SessionState has no field for one, and storage entries whose key names a password are dropped.
//
// When expo-secure-store is unavailable (a simulator without a keychain), saving fails closed with
// SessionUnavailableError and loading returns nothing, so the person signs in every run. There is
// no fallback to AsyncStorage or a file.
//
// The native pieces (expo-secure-store, the cookie manager, expo-crypto, the Supabase RPCs) are
// injected; nativeSession.ts builds them. Tests pass fakes and Web Crypto.

import { base64ToBytes, bytesToBase64, utf8Decode, utf8Encode } from "./bytes";

export type CookieSameSite = "lax" | "strict" | "none";

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** ISO timestamp; absent for a session cookie. */
  expires?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: CookieSameSite;
}

export interface SessionState {
  cookies: Cookie[];
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  savedAt: string;
  /** The origin the two storage maps belong to, for example https://www.safeway.com. */
  origin: string;
}

/** expo-secure-store, as this module uses it. */
export interface SecureStoreLike {
  isAvailableAsync(): Promise<boolean>;
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

/** The WebView's cookie store. */
export interface CookieJar {
  /** Every cookie the store holds for these registered domains and their subdomains. */
  read(domains: readonly string[]): Promise<Cookie[]>;
  write(cookies: readonly Cookie[]): Promise<void>;
  /** Removes these domains' cookies, so nothing of the session is left in plaintext at rest. */
  clearDomains(domains: readonly string[]): Promise<void>;
  /** Wipes the WebView cookie store (Disconnect). */
  clearAll(): Promise<void>;
}

/** The two Supabase RPCs (supabase/migrations/20261031110000_ws08_tier3.sql). */
export interface SessionKeyService {
  /** connection_session_key(connection_id): the base64 key, for the connection's own member. */
  fetchKey(connectionId: string): Promise<string>;
  /** revoke_browser_connection(connection_id): deletes the Vault key, marks the row revoked. */
  revoke(connectionId: string): Promise<void>;
}

/** AES-256-GCM with the connection id as additional data. Output is base64(iv | ciphertext | tag). */
export interface SessionCipher {
  encrypt(plaintext: string, keyB64: string, aad: string): Promise<string>;
  decrypt(sealedB64: string, keyB64: string, aad: string): Promise<string>;
}

export interface SessionVaultDeps {
  store: SecureStoreLike;
  cookies: CookieJar;
  keys: SessionKeyService;
  cipher: SessionCipher;
  now?: () => Date;
}

export class SessionUnavailableError extends Error {
  readonly code = "secure_store_unavailable";
  constructor() {
    super("This device cannot keep a session safely, so you will sign in each time.");
    this.name = "SessionUnavailableError";
  }
}

export const BLOB_PREFIX = "v1.";

export function sessionStorageKey(connectionId: string): string {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(connectionId)) throw new Error("bad connection id");
  return `tier3.session.${connectionId}`;
}

const PASSWORDISH = /pass(?:word|wd|phrase)?|pwd|credential/i;
/** Our own marker in sessionStorage (the restore script's run flag). Never saved. */
export const RESTORE_MARKER_PREFIX = "__mp_tier3_restored_";

function cleanStorage(map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    if (PASSWORDISH.test(k) || k.startsWith(RESTORE_MARKER_PREFIX)) continue;
    out[k] = v;
  }
  return out;
}

/** Drops what a session must never hold. Applied on every save. */
export function sanitizeSession(state: SessionState): SessionState {
  return {
    cookies: state.cookies.filter((c) => !PASSWORDISH.test(c.name)),
    localStorage: cleanStorage(state.localStorage),
    sessionStorage: cleanStorage(state.sessionStorage),
    savedAt: state.savedAt,
    origin: state.origin,
  };
}

function isRecordOfStrings(v: unknown): v is Record<string, string> {
  return (
    !!v &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Object.values(v).every((x) => typeof x === "string")
  );
}

export function parseSessionState(value: unknown): SessionState | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (
    !Array.isArray(v.cookies) ||
    !isRecordOfStrings(v.localStorage) ||
    !isRecordOfStrings(v.sessionStorage) ||
    typeof v.savedAt !== "string" ||
    typeof v.origin !== "string"
  ) {
    return null;
  }
  const cookies = v.cookies.filter(
    (c): c is Cookie =>
      !!c &&
      typeof c === "object" &&
      typeof (c as Cookie).name === "string" &&
      typeof (c as Cookie).value === "string" &&
      typeof (c as Cookie).domain === "string" &&
      typeof (c as Cookie).path === "string",
  );
  return {
    cookies,
    localStorage: v.localStorage,
    sessionStorage: v.sessionStorage,
    savedAt: v.savedAt,
    origin: v.origin,
  };
}

export interface SessionVault {
  saveSession(connectionId: string, state: SessionState): Promise<void>;
  loadSession(connectionId: string): Promise<SessionState | null>;
  wipeSession(connectionId: string): Promise<void>;
  /** Drops the in-memory keys (end of a run, app in the background). */
  forgetKeys(): void;
}

export function createSessionVault(deps: SessionVaultDeps): SessionVault {
  // Keys live here for the run and nowhere else.
  const keys = new Map<string, string>();

  async function keyFor(connectionId: string): Promise<string> {
    const cached = keys.get(connectionId);
    if (cached) return cached;
    const key = await deps.keys.fetchKey(connectionId);
    if (!key) throw new Error("no session key");
    keys.set(connectionId, key);
    return key;
  }

  return {
    async saveSession(connectionId, state) {
      const storeKey = sessionStorageKey(connectionId);
      if (!(await deps.store.isAvailableAsync())) throw new SessionUnavailableError();
      const clean = sanitizeSession(state);
      const sealed = await deps.cipher.encrypt(
        JSON.stringify(clean),
        await keyFor(connectionId),
        connectionId,
      );
      await deps.store.setItemAsync(storeKey, `${BLOB_PREFIX}${sealed}`);
    },

    async loadSession(connectionId) {
      const storeKey = sessionStorageKey(connectionId);
      if (!(await deps.store.isAvailableAsync())) return null;
      const blob = await deps.store.getItemAsync(storeKey);
      if (!blob?.startsWith(BLOB_PREFIX)) return null;
      // A key that cannot be fetched (offline, not yours, revoked) is an error, not a reason to
      // drop the blob.
      const key = await keyFor(connectionId);
      try {
        const plain = await deps.cipher.decrypt(blob.slice(BLOB_PREFIX.length), key, connectionId);
        return parseSessionState(JSON.parse(plain));
      } catch {
        // A key that no longer opens the blob (a reconnect made a new one): the old session is
        // gone for good, so drop it and let the person sign in.
        keys.delete(connectionId);
        await deps.store.deleteItemAsync(storeKey).catch(() => {});
        return null;
      }
    },

    async wipeSession(connectionId) {
      const storeKey = sessionStorageKey(connectionId);
      keys.delete(connectionId);
      // Every step runs even when one fails, so one broken piece never leaves the others behind.
      // The phone first, so Disconnect clears it even offline; then the server. The first error is
      // rethrown at the end, so the person sees that something needs another try.
      const errors: unknown[] = [];
      const step = async (run: () => Promise<void>) => {
        try {
          await run();
        } catch (err) {
          errors.push(err);
        }
      };
      await step(() => deps.cookies.clearAll());
      await step(async () => {
        if (await deps.store.isAvailableAsync()) await deps.store.deleteItemAsync(storeKey);
      });
      await step(() => deps.keys.revoke(connectionId));
      if (errors.length > 0) throw errors[0];
    },

    forgetKeys() {
      keys.clear();
    },
  };
}

// ---------------------------------------------------------------------------------------
// The app's vault. Built from the native modules on first use; tests configure their own.
// ---------------------------------------------------------------------------------------

let appVault: SessionVault | null = null;

export function configureSessionVault(vault: SessionVault | null): void {
  appVault = vault;
}

/** The vault the app uses: the configured one, else the native one built on first use. */
export function appSessionVault(): SessionVault {
  if (!appVault) {
    const { nativeSessionVault } = require("./nativeSession") as typeof import("./nativeSession");
    appVault = nativeSessionVault();
  }
  return appVault;
}

export function saveSession(connectionId: string, state: SessionState): Promise<void> {
  return appSessionVault().saveSession(connectionId, state);
}

export function loadSession(connectionId: string): Promise<SessionState | null> {
  return appSessionVault().loadSession(connectionId);
}

export function wipeSession(connectionId: string): Promise<void> {
  return appSessionVault().wipeSession(connectionId);
}

export function forgetSessionKeys(): void {
  appVault?.forgetKeys();
}

/** The same cipher over Web Crypto (Node, browsers). The format matches nativeSession's. */
export function webCryptoCipher(
  subtle: SubtleCrypto,
  random: (n: number) => Uint8Array,
): SessionCipher {
  const importKey = (keyB64: string) =>
    subtle.importKey("raw", base64ToBytes(keyB64) as BufferSource, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
  return {
    async encrypt(plaintext, keyB64, aad) {
      const iv = random(12);
      const ct = new Uint8Array(
        await subtle.encrypt(
          {
            name: "AES-GCM",
            iv: iv as BufferSource,
            additionalData: utf8Encode(aad) as BufferSource,
          },
          await importKey(keyB64),
          utf8Encode(plaintext) as BufferSource,
        ),
      );
      const out = new Uint8Array(iv.length + ct.length);
      out.set(iv, 0);
      out.set(ct, iv.length);
      return bytesToBase64(out);
    },
    async decrypt(sealedB64, keyB64, aad) {
      const bytes = base64ToBytes(sealedB64);
      const plain = await subtle.decrypt(
        {
          name: "AES-GCM",
          iv: bytes.subarray(0, 12) as BufferSource,
          additionalData: utf8Encode(aad) as BufferSource,
        },
        await importKey(keyB64),
        bytes.subarray(12) as BufferSource,
      );
      return utf8Decode(new Uint8Array(plain));
    },
  };
}
