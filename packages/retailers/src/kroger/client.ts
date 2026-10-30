// The one place that talks HTTP to Kroger. Catalog GETs go through the quota guard and the
// header-bounded cache; customer calls (cart, identity) go through the quota guard only.
import { RetailerAuthError, RetailerRequestError } from "../errors.ts";
import type { KrogerAuth } from "./auth.ts";
import { cacheDecision, type ResponseCache } from "./cache.ts";
import type { KrogerEndpoint, QuotaGuard } from "./quota.ts";

export interface CatalogResponse<T> {
  body: T;
  /** Epoch ms from the cache headers. Equal to the fetch time when Kroger sent none. */
  expiresAt: number;
  fromCache: boolean;
}

export interface KrogerClientDeps {
  auth: KrogerAuth;
  quota: QuotaGuard;
  cache: ResponseCache<unknown>;
  fetch?: typeof fetch;
  now?: () => number;
}

/** Reads Kroger's error body ({ errors: { code, reason } } or { message }) for the message. */
async function errorFrom(res: Response): Promise<RetailerRequestError> {
  let code: string | null = null;
  let reason = `Kroger answered ${res.status}`;
  try {
    const body = (await res.json()) as {
      errors?: { code?: string; reason?: string };
      message?: string;
      error_description?: string;
    };
    code = body.errors?.code ?? null;
    reason = body.errors?.reason ?? body.message ?? body.error_description ?? reason;
  } catch {
    // Keep the status line.
  }
  return new RetailerRequestError("kroger", res.status, reason, { retailerCode: code });
}

export class KrogerClient {
  readonly #auth: KrogerAuth;
  readonly #quota: QuotaGuard;
  readonly #cache: ResponseCache<unknown>;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(deps: KrogerClientDeps) {
    this.#auth = deps.auth;
    this.#quota = deps.quota;
    this.#cache = deps.cache;
    this.#fetch = deps.fetch ?? ((input, init) => fetch(input, init));
    this.#now = deps.now ?? Date.now;
  }

  url(path: string, params?: URLSearchParams): string {
    const query = params?.toString();
    return `${this.#auth.baseUrl}${path}${query ? `?${query}` : ""}`;
  }

  /**
   * A catalog GET with the app token. A fresh cached copy answers without a network call and
   * without spending quota. One 401 renews the app token and retries once.
   */
  async catalog<T>(
    endpoint: KrogerEndpoint,
    path: string,
    params?: URLSearchParams,
  ): Promise<CatalogResponse<T>> {
    const url = this.url(path, params);
    const cached = this.#cache.get(url);
    if (cached) return { body: cached.value as T, expiresAt: cached.expiresAt, fromCache: true };

    let res = await this.#send(endpoint, url, { method: "GET" }, await this.#auth.appToken());
    if (res.status === 401) {
      this.#auth.invalidateAppToken();
      res = await this.#send(endpoint, url, { method: "GET" }, await this.#auth.appToken());
      if (res.status === 401) {
        throw new RetailerAuthError("kroger", "app_credentials", "Kroger refused the app token");
      }
    }
    if (!res.ok) throw await errorFrom(res);

    const now = this.#now();
    const body = (await res.json()) as T;
    const decision = cacheDecision(res.headers, now);
    if (decision.storable) this.#cache.set(url, body, decision.expiresAt);
    return { body, expiresAt: decision.expiresAt, fromCache: false };
  }

  /**
   * A customer call with a bearer token the caller supplies. Returns the raw response so the
   * caller can handle 401 with its own refresh. Quota is spent before the call.
   */
  async customer(
    endpoint: KrogerEndpoint,
    path: string,
    init: { method: string; body?: unknown },
    accessToken: string,
  ): Promise<Response> {
    return this.#send(
      endpoint,
      this.url(path),
      {
        method: init.method,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      },
      accessToken,
      init.body === undefined ? undefined : "application/json",
    );
  }

  async #send(
    endpoint: KrogerEndpoint,
    url: string,
    init: { method: string; body?: string },
    token: string,
    contentType?: string,
  ): Promise<Response> {
    await this.#quota.reserve(endpoint);
    const res = await this.#fetch(url, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(contentType ? { "Content-Type": contentType } : {}),
      },
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    await this.#quota.observe(endpoint, res.status, res.headers);
    if (res.status === 429) throw this.#quota.quotaError(endpoint);
    return res;
  }
}

export { errorFrom };
