// Kroger OAuth2 (docs/04-integrations.md §Kroger, Auth).
//
//   * Catalog calls use client_credentials with scope product.compact. That token belongs to the
//     app, lives in memory, and is renewed a minute before its 30 minutes run out.
//   * Cart calls use the customer's authorization_code token (scope cart.basic:write). The
//     authorize step uses PKCE S256 and the `banner` parameter. Only the refresh token is kept, in
//     Supabase Vault; Kroger reissues it on every refresh, so every refresh rotates the secret.
//     Access tokens stay in memory for the life of a run.
//   * The OAuth `state` is sealed (AES-GCM, key derived from the client secret) and carries the
//     household, the user, the PKCE verifier, and an expiry. The server needs no table for
//     pending logins, and the verifier never sits in a URL in the clear.
//
// WebCrypto only (globalThis.crypto), so this runs in Node 22, Deno, and the worker alike.
import { RetailerAuthError, RetailerRequestError } from "../errors.ts";
import type { Banner, ConnectionHandle, Modality } from "../types.ts";
import type { Rpc } from "./quota.ts";

export const KROGER_API_BASE = "https://api.kroger.com/v1";
/** Certification host: catalog only, no customer accounts (Cart and Identity cannot run there). */
export const KROGER_CERT_API_BASE = "https://api-ce.kroger.com/v1";

export const CATALOG_SCOPE = "product.compact";
/** cart.basic:write for adds; profile.compact so the exchange can verify the account. */
export const CUSTOMER_SCOPES = ["cart.basic:write", "profile.compact"] as const;

/** How long a sealed state stays valid: long enough to sign in, short enough to be useless later. */
export const STATE_TTL_MS = 10 * 60 * 1000;
/** Renew tokens this long before Kroger's expiry. */
const EXPIRY_MARGIN_MS = 60 * 1000;

// ---------------------------------------------------------------------------------------
// Encoding helpers (no Buffer: this module also runs in Deno)
// ---------------------------------------------------------------------------------------

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ---------------------------------------------------------------------------------------
// Banner and PKCE
// ---------------------------------------------------------------------------------------

/** The consent-screen banner for a Kroger chain code. Undefined for chains we do not brand. */
export function bannerForChain(chain: string | null | undefined): Banner | undefined {
  const code = chain?.trim().toUpperCase() ?? "";
  if (code === "QFC") return "qfc";
  if (code === "FRED" || code.startsWith("FRED MEYER")) return "fredmeyer";
  return undefined;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** RFC 7636 S256: a 43-character verifier from 32 random bytes and its SHA-256 challenge. */
export async function createPkcePair(
  randomBytes: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n)),
): Promise<PkcePair> {
  const verifier = base64UrlEncode(randomBytes(32));
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
  return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)) };
}

export interface AuthorizeUrlInput {
  baseUrl?: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes?: readonly string[];
  banner?: Banner;
}

export function buildAuthorizeUrl(input: AuthorizeUrlInput): string {
  const url = new URL(`${input.baseUrl ?? KROGER_API_BASE}/connect/oauth2/authorize`);
  url.searchParams.set("scope", (input.scopes ?? CUSTOMER_SCOPES).join(" "));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (input.banner) url.searchParams.set("banner", input.banner);
  return url.toString();
}

// ---------------------------------------------------------------------------------------
// Sealed state
// ---------------------------------------------------------------------------------------

export interface OAuthState {
  householdId: string;
  userId: string;
  verifier: string;
  banner?: Banner;
  /** Epoch ms. */
  expiresAt: number;
  nonce: string;
}

async function stateKey(secret: string) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode("souvie.retailer-oauth.state"),
      info: encoder.encode("kroger.v1"),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypts and authenticates the state. The output is URL-safe. */
export async function sealState(
  payload: Omit<OAuthState, "nonce" | "expiresAt"> & { now: number; nonce?: string },
  secret: string,
): Promise<string> {
  const { now, nonce, ...rest } = payload;
  const body: OAuthState = {
    ...rest,
    expiresAt: now + STATE_TTL_MS,
    nonce: nonce ?? base64UrlEncode(crypto.getRandomValues(new Uint8Array(12))),
  };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await stateKey(secret);
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(JSON.stringify(body)),
  );
  return `v1.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(cipher))}`;
}

/** Opens a sealed state. Throws RetailerAuthError when it was tampered with or has expired. */
export async function openState(state: string, secret: string, now: number): Promise<OAuthState> {
  const [version, ivPart, cipherPart] = state.split(".");
  if (version !== "v1" || !ivPart || !cipherPart) {
    throw new RetailerAuthError("kroger", "invalid_state", "The sign-in state is not ours");
  }
  let body: OAuthState;
  try {
    const key = await stateKey(secret);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlDecode(ivPart) },
      key,
      base64UrlDecode(cipherPart),
    );
    body = JSON.parse(decoder.decode(plain)) as OAuthState;
  } catch (cause) {
    throw new RetailerAuthError("kroger", "invalid_state", "The sign-in state is not ours", {
      cause,
    });
  }
  if (typeof body.expiresAt !== "number" || now > body.expiresAt) {
    throw new RetailerAuthError("kroger", "expired_state", "The sign-in took too long. Try again.");
  }
  return body;
}

// ---------------------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------------------

export interface KrogerTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type?: string;
  scope?: string;
}

export interface AccessToken {
  accessToken: string;
  /** Epoch ms when Kroger says it expires. */
  expiresAt: number;
}

export interface CustomerTokens extends AccessToken {
  /** Kroger issues a new one on every refresh. Store it; drop the old one. */
  refreshToken: string;
}

export interface KrogerAuthConfig {
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export class KrogerAuth {
  readonly #config: KrogerAuthConfig;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #appToken: AccessToken | null = null;
  #appTokenPending: Promise<AccessToken> | null = null;

  constructor(config: KrogerAuthConfig) {
    if (!config.clientId || !config.clientSecret) {
      throw new Error("KrogerAuth needs KROGER_CLIENT_ID and KROGER_CLIENT_SECRET");
    }
    this.#config = config;
    this.#fetch = config.fetch ?? ((input, init) => fetch(input, init));
    this.#now = config.now ?? Date.now;
  }

  get baseUrl(): string {
    return this.#config.baseUrl ?? KROGER_API_BASE;
  }

  get clientId(): string {
    return this.#config.clientId;
  }

  async #token(form: Record<string, string>): Promise<KrogerTokenResponse> {
    const basic = btoa(`${this.#config.clientId}:${this.#config.clientSecret}`);
    const res = await this.#fetch(`${this.baseUrl}/connect/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams(form).toString(),
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      // Not JSON. The status decides.
    }
    if (!res.ok) {
      const error = typeof body.error === "string" ? body.error : "";
      if (error === "invalid_grant") {
        throw new RetailerAuthError("kroger", "invalid_grant", "Kroger refused the sign-in", {
          needsReauth: true,
        });
      }
      if (res.status === 401 || error === "invalid_client") {
        throw new RetailerAuthError("kroger", "app_credentials", "Kroger refused the app's keys");
      }
      throw new RetailerRequestError("kroger", res.status, `Kroger token request failed`, {
        retailerCode: error || null,
      });
    }
    if (typeof body.access_token !== "string" || typeof body.expires_in !== "number") {
      throw new RetailerRequestError("kroger", res.status, "Kroger token response was malformed");
    }
    return body as unknown as KrogerTokenResponse;
  }

  /** The app's catalog token. Shared by every caller of this instance until it nears expiry. */
  async appToken(): Promise<string> {
    if (this.#appToken && this.#now() < this.#appToken.expiresAt - EXPIRY_MARGIN_MS) {
      return this.#appToken.accessToken;
    }
    this.#appTokenPending ??= this.#token({
      grant_type: "client_credentials",
      scope: CATALOG_SCOPE,
    })
      .then((t) => ({ accessToken: t.access_token, expiresAt: this.#now() + t.expires_in * 1000 }))
      .finally(() => {
        this.#appTokenPending = null;
      });
    this.#appToken = await this.#appTokenPending;
    return this.#appToken.accessToken;
  }

  /** Forgets the app token, for example after a 401 on a catalog call. */
  invalidateAppToken(): void {
    this.#appToken = null;
  }

  /** Exchanges an authorization code (with its PKCE verifier) for the customer's tokens. */
  async exchangeCode(code: string, verifier: string, redirectUri: string): Promise<CustomerTokens> {
    const t = await this.#token({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
    return this.#customer(t);
  }

  /** Trades a refresh token for new tokens. The returned refresh token replaces the old one. */
  async refresh(refreshToken: string): Promise<CustomerTokens> {
    const t = await this.#token({ grant_type: "refresh_token", refresh_token: refreshToken });
    return this.#customer(t);
  }

  #customer(t: KrogerTokenResponse): CustomerTokens {
    if (!t.refresh_token) {
      throw new RetailerRequestError("kroger", 200, "Kroger returned no refresh token");
    }
    return {
      accessToken: t.access_token,
      refreshToken: t.refresh_token,
      expiresAt: this.#now() + t.expires_in * 1000,
    };
  }
}

// ---------------------------------------------------------------------------------------
// Vault: where refresh tokens live
// ---------------------------------------------------------------------------------------

export interface SaveConnectionInput {
  householdId: string;
  userId: string;
  refreshToken: string;
  storeId?: string | null;
  storeName?: string | null;
  modality?: Modality | null;
}

/**
 * Supabase Vault access for refresh tokens. The interface takes refresh tokens and nothing else:
 * access tokens never reach it. The real implementation is createRpcVault over the WS07 SQL
 * functions, which run as security definer and are callable by the service role only.
 */
export interface RefreshTokenVault {
  /** Creates or re-activates the household member's Kroger connection, secret included. */
  saveConnection(input: SaveConnectionInput): Promise<{ connectionId: string }>;
  /** The current refresh token, or null when the connection is revoked or its owner left. */
  read(connectionId: string): Promise<string | null>;
  /** Replaces the stored refresh token in place. The old value is gone after this. */
  rotate(connectionId: string, refreshToken: string): Promise<void>;
  /** Flips the connection to needs_reauth so the app prompts its owner. */
  markNeedsReauth(connectionId: string): Promise<void>;
}

function rpcFailed(fn: string, error: { message: string }): Error {
  return new Error(`${fn} failed: ${error.message}`);
}

export function createRpcVault(rpc: Rpc): RefreshTokenVault {
  return {
    async saveConnection(input) {
      const { data, error } = await rpc("retailer_save_oauth_connection", {
        p_household_id: input.householdId,
        p_user_id: input.userId,
        p_retailer: "kroger",
        p_refresh_token: input.refreshToken,
        p_store_id: input.storeId ?? null,
        p_store_name: input.storeName ?? null,
        p_modality: input.modality ? input.modality.toLowerCase() : null,
      });
      if (error) throw rpcFailed("retailer_save_oauth_connection", error);
      if (typeof data !== "string")
        throw new Error("retailer_save_oauth_connection returned no id");
      return { connectionId: data };
    },
    async read(connectionId) {
      const { data, error } = await rpc("retailer_read_refresh_token", {
        p_connection_id: connectionId,
      });
      if (error) throw rpcFailed("retailer_read_refresh_token", error);
      return typeof data === "string" && data.length > 0 ? data : null;
    },
    async rotate(connectionId, refreshToken) {
      const { error } = await rpc("retailer_rotate_refresh_token", {
        p_connection_id: connectionId,
        p_refresh_token: refreshToken,
      });
      if (error) throw rpcFailed("retailer_rotate_refresh_token", error);
    },
    async markNeedsReauth(connectionId) {
      const { error } = await rpc("retailer_mark_needs_reauth", { p_connection_id: connectionId });
      if (error) throw rpcFailed("retailer_mark_needs_reauth", error);
    },
  };
}

// ---------------------------------------------------------------------------------------
// Customer access tokens, in memory
// ---------------------------------------------------------------------------------------

/**
 * Hands out customer access tokens for cart calls. Reads the refresh token from Vault once per
 * connection, refreshes, writes the reissued refresh token back (rotation), and keeps the access
 * token in memory until it nears expiry. Never retries auth in a loop: one refresh per call site.
 */
export class CustomerTokenCache {
  readonly #auth: KrogerAuth;
  readonly #vault: RefreshTokenVault;
  readonly #now: () => number;
  readonly #tokens = new Map<string, AccessToken>();
  readonly #pending = new Map<string, Promise<AccessToken>>();

  constructor(auth: KrogerAuth, vault: RefreshTokenVault, now: () => number = Date.now) {
    this.#auth = auth;
    this.#vault = vault;
    this.#now = now;
  }

  /** Seeds the cache with a token the exchange just produced, so the first cart call skips a refresh. */
  prime(connectionId: string, token: AccessToken): void {
    this.#tokens.set(connectionId, token);
  }

  invalidate(connectionId: string): void {
    this.#tokens.delete(connectionId);
  }

  async get(conn: ConnectionHandle): Promise<string> {
    const cached = this.#tokens.get(conn.connectionId);
    if (cached && this.#now() < cached.expiresAt - EXPIRY_MARGIN_MS) return cached.accessToken;
    return (await this.refresh(conn)).accessToken;
  }

  /** Forces a refresh (after a 401). Concurrent callers share one refresh. */
  refresh(conn: ConnectionHandle): Promise<AccessToken> {
    const id = conn.connectionId;
    let pending = this.#pending.get(id);
    if (!pending) {
      pending = this.#refresh(id).finally(() => this.#pending.delete(id));
      this.#pending.set(id, pending);
    }
    return pending;
  }

  async #refresh(connectionId: string): Promise<AccessToken> {
    this.#tokens.delete(connectionId);
    const refreshToken = await this.#vault.read(connectionId);
    if (!refreshToken) {
      throw new RetailerAuthError(
        "kroger",
        "missing_token",
        "This Kroger connection has no token",
        {
          connectionId,
          needsReauth: true,
        },
      );
    }
    let tokens: CustomerTokens;
    try {
      tokens = await this.#auth.refresh(refreshToken);
    } catch (err) {
      if (err instanceof RetailerAuthError && err.needsReauth) {
        await this.#vault.markNeedsReauth(connectionId);
        throw new RetailerAuthError("kroger", err.reason, err.message, {
          connectionId,
          needsReauth: true,
          cause: err,
        });
      }
      throw err;
    }
    // Kroger has already invalidated the old refresh token; store the new one before using it.
    await this.#vault.rotate(connectionId, tokens.refreshToken);
    const access = { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt };
    this.#tokens.set(connectionId, access);
    return access;
  }
}

// ---------------------------------------------------------------------------------------
// The callback: code + state -> a stored connection
// ---------------------------------------------------------------------------------------

export interface CompleteAuthorizationInput {
  code: string;
  state: string;
  /** The signed-in caller. Must be the user the state was sealed for. */
  userId: string;
  /** Must equal the redirect_uri of the authorize step. */
  redirectUri: string;
  storeId?: string | null;
  storeName?: string | null;
  modality?: Modality | null;
}

export interface CompleteAuthorizationDeps {
  auth: KrogerAuth;
  vault: RefreshTokenVault;
  stateSecret: string;
  now?: () => number;
  /** When given, the fresh access token is kept here (memory) for the rest of the run. */
  tokens?: CustomerTokenCache;
}

export interface CompletedAuthorization {
  householdId: string;
  handle: ConnectionHandle;
  /** Memory only. Never stored, never returned to a client. */
  accessToken: AccessToken;
}

/**
 * Opens the sealed state, checks it belongs to the caller, exchanges the code, and stores the
 * refresh token through the vault. The access token is handed back for immediate use only.
 */
export async function completeAuthorization(
  input: CompleteAuthorizationInput,
  deps: CompleteAuthorizationDeps,
): Promise<CompletedAuthorization> {
  const now = deps.now ?? Date.now;
  const state = await openState(input.state, deps.stateSecret, now());
  if (state.userId !== input.userId) {
    throw new RetailerAuthError(
      "kroger",
      "state_mismatch",
      "This sign-in was started by someone else",
    );
  }
  const tokens = await deps.auth.exchangeCode(input.code, state.verifier, input.redirectUri);
  const { connectionId } = await deps.vault.saveConnection({
    householdId: state.householdId,
    userId: state.userId,
    refreshToken: tokens.refreshToken,
    storeId: input.storeId ?? null,
    storeName: input.storeName ?? null,
    modality: input.modality ?? null,
  });
  const accessToken = { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt };
  deps.tokens?.prime(connectionId, accessToken);
  return {
    householdId: state.householdId,
    handle: {
      connectionId,
      retailer: "kroger",
      storeId: input.storeId ?? null,
      ...(input.modality ? { modality: input.modality } : {}),
    },
    accessToken,
  };
}
