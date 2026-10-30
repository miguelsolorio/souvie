// Response cache bounded by the retailer's own cache headers (Kroger terms: "no cached copies
// beyond the response cache header"). There is no TTL of ours: a response with no Cache-Control
// max-age and no Expires is never stored, and its data expires the moment it arrives.
//
// In memory only, per adapter instance (one worker run or one Edge Function instance). Nothing
// here is written to disk or a table.

export interface HeaderSource {
  get(name: string): string | null;
}

export interface CacheDecision {
  /** Epoch ms after which the response is stale. Equal to `now` when it was never fresh. */
  expiresAt: number;
  /** Whether the response may be stored at all. */
  storable: boolean;
}

function directives(cacheControl: string | null): Map<string, string | true> {
  const out = new Map<string, string | true>();
  if (!cacheControl) return out;
  for (const part of cacheControl.split(",")) {
    const [rawName, ...rest] = part.split("=");
    const name = rawName?.trim().toLowerCase();
    if (!name) continue;
    const value = rest.join("=").trim().replace(/^"|"$/g, "");
    out.set(name, value === "" ? true : value);
  }
  return out;
}

function seconds(value: string | true | undefined): number | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  return Number(value);
}

/**
 * Freshness from Cache-Control and Expires only (RFC 9111 §4.2.1, as a private cache).
 * `max-age` wins over `Expires`. `no-store` and `no-cache` mean never stored: we do not revalidate.
 * `Age` is subtracted from `max-age`. `Expires` is read relative to the response `Date` when there
 * is one, so a skewed retailer clock does not stretch the lifetime.
 */
export function cacheDecision(headers: HeaderSource, now: number): CacheDecision {
  const cc = directives(headers.get("cache-control"));
  const stale: CacheDecision = { expiresAt: now, storable: false };
  if (cc.has("no-store") || cc.has("no-cache")) return stale;

  const age = seconds(headers.get("age") ?? undefined) ?? 0;
  const maxAge = seconds(cc.get("max-age"));
  let lifetimeMs: number | null = null;
  if (maxAge !== null) {
    lifetimeMs = (maxAge - age) * 1000;
  } else {
    const expires = headers.get("expires");
    if (expires !== null) {
      const expiresMs = Date.parse(expires);
      if (Number.isNaN(expiresMs)) return stale; // "Expires: 0" and friends mean already expired.
      const dateMs = Date.parse(headers.get("date") ?? "");
      lifetimeMs = expiresMs - (Number.isNaN(dateMs) ? now : dateMs);
    }
  }
  if (lifetimeMs === null || lifetimeMs <= 0) return stale;
  return { expiresAt: now + lifetimeMs, storable: true };
}

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export interface ResponseCacheOptions {
  now?: () => number;
  /** Least recently used entries go first past this. */
  maxEntries?: number;
}

export class ResponseCache<T> {
  readonly #entries = new Map<string, Entry<T>>();
  readonly #now: () => number;
  readonly #maxEntries: number;

  constructor(options: ResponseCacheOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#maxEntries = options.maxEntries ?? 500;
  }

  /** The fresh entry for `key`, or undefined. Stale entries are dropped on read. */
  get(key: string): Entry<T> | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (this.#now() >= entry.expiresAt) {
      this.#entries.delete(key);
      return undefined;
    }
    // Refresh recency.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry;
  }

  /** Stores `value` until `expiresAt`. A value that is already stale is not stored. */
  set(key: string, value: T, expiresAt: number): void {
    if (expiresAt <= this.#now()) {
      this.#entries.delete(key);
      return;
    }
    this.#entries.delete(key);
    this.#entries.set(key, { value, expiresAt });
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  /** Drops every stale entry. */
  prune(): void {
    const now = this.#now();
    for (const [key, entry] of this.#entries) {
      if (now >= entry.expiresAt) this.#entries.delete(key);
    }
  }

  clear(): void {
    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }
}
