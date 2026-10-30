// Daily call budgets for the Kroger public tier (R15). The quota is shared by every household on
// one client id, so the count lives in `retailer_quota_usage`, not in memory. `reserve()` runs
// before every network call and throws RetailerQuotaError once 95% of the day's budget is spent,
// so WS09 can pause a run before Kroger answers 429.
//
// Kroger's day resets at 00:00 UTC (the `ratelimit-reset` header counts down to it).
import { RetailerQuotaError } from "../errors.ts";
import type { RetailerId } from "../types.ts";
import type { HeaderSource } from "./cache.ts";

export const KROGER_ENDPOINTS = [
  "products",
  "cart",
  "identity",
  "locations",
  "chains",
  "departments",
] as const;
export type KrogerEndpoint = (typeof KROGER_ENDPOINTS)[number];

/**
 * Published public-tier limits (docs/04-integrations.md §Kroger). Locations is 1,600 per endpoint
 * in the published docs; the live headers have reported 5,000 (docs/09-open-questions.md). The
 * lower number stands until Kroger confirms, and a lower number in the headers always wins.
 */
export const KROGER_DAILY_QUOTAS: Readonly<Record<KrogerEndpoint, number>> = Object.freeze({
  products: 10_000,
  cart: 5_000,
  identity: 5_000,
  locations: 1_600,
  chains: 1_600,
  departments: 1_600,
});

/** Callers degrade at this share of the budget, before Kroger refuses. */
export const QUOTA_THRESHOLD = 0.95;

export interface QuotaConsumeResult {
  allowed: boolean;
  /** The day's count after this call (or as it stands, when refused). */
  used: number;
}

/** Persistence for daily counts. `consume` must be atomic across processes. */
export interface QuotaStore {
  /** Adds `amount` to the day's count only if the result stays at or under `ceiling`. */
  consume(
    retailer: RetailerId,
    endpoint: string,
    day: string,
    ceiling: number,
    amount: number,
  ): Promise<QuotaConsumeResult>;
  /** Raises the day's count to at least `count` (from the retailer's own headers). */
  raiseTo(retailer: RetailerId, endpoint: string, day: string, count: number): Promise<void>;
}

/** For tests and single-process tools. */
export class InMemoryQuotaStore implements QuotaStore {
  readonly counts = new Map<string, number>();

  #key(retailer: string, endpoint: string, day: string): string {
    return `${retailer}|${endpoint}|${day}`;
  }

  async consume(
    retailer: RetailerId,
    endpoint: string,
    day: string,
    ceiling: number,
    amount: number,
  ): Promise<QuotaConsumeResult> {
    const key = this.#key(retailer, endpoint, day);
    const current = this.counts.get(key) ?? 0;
    if (current + amount > ceiling) return { allowed: false, used: current };
    this.counts.set(key, current + amount);
    return { allowed: true, used: current + amount };
  }

  async raiseTo(retailer: RetailerId, endpoint: string, day: string, count: number): Promise<void> {
    const key = this.#key(retailer, endpoint, day);
    this.counts.set(key, Math.max(this.counts.get(key) ?? 0, count));
  }
}

/** Calls a Postgres function, supabase-js style. Keeps this package free of supabase-js. */
export type Rpc = (
  fn: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

/** QuotaStore over the WS07 SQL functions `retailer_quota_consume` and `retailer_quota_raise`. */
export function createRpcQuotaStore(rpc: Rpc): QuotaStore {
  return {
    async consume(retailer, endpoint, day, ceiling, amount) {
      const { data, error } = await rpc("retailer_quota_consume", {
        p_retailer: retailer,
        p_endpoint: endpoint,
        p_day: day,
        p_ceiling: ceiling,
        p_amount: amount,
      });
      if (error) throw new Error(`retailer_quota_consume failed: ${error.message}`);
      const row = (Array.isArray(data) ? data[0] : data) as
        | { allowed?: boolean; used?: number }
        | null
        | undefined;
      return { allowed: row?.allowed === true, used: Number(row?.used ?? 0) };
    },
    async raiseTo(retailer, endpoint, day, count) {
      const { error } = await rpc("retailer_quota_raise", {
        p_retailer: retailer,
        p_endpoint: endpoint,
        p_day: day,
        p_count: count,
      });
      if (error) throw new Error(`retailer_quota_raise failed: ${error.message}`);
    },
  };
}

/** The UTC calendar day of `now`, as YYYY-MM-DD. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** The next 00:00 UTC after `now`. */
export function nextUtcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

export interface QuotaGuardOptions {
  store: QuotaStore;
  retailer?: RetailerId;
  now?: () => Date;
  quotas?: Partial<Record<KrogerEndpoint, number>>;
  threshold?: number;
}

export class QuotaGuard {
  readonly #store: QuotaStore;
  readonly #retailer: RetailerId;
  readonly #now: () => Date;
  readonly #limits: Record<KrogerEndpoint, number>;
  readonly #threshold: number;
  /** The day's count as of our last reserve, so headers only cost a write when they say more. */
  readonly #known = new Map<string, number>();

  constructor(options: QuotaGuardOptions) {
    this.#store = options.store;
    this.#retailer = options.retailer ?? "kroger";
    this.#now = options.now ?? (() => new Date());
    this.#limits = { ...KROGER_DAILY_QUOTAS, ...options.quotas };
    this.#threshold = options.threshold ?? QUOTA_THRESHOLD;
  }

  limit(endpoint: KrogerEndpoint): number {
    return this.#limits[endpoint];
  }

  /** The highest count at which calls are still allowed: 9,500 of 10,000 for Products. */
  ceiling(endpoint: KrogerEndpoint): number {
    return Math.floor(this.#limits[endpoint] * this.#threshold);
  }

  /** Counts one call against today's budget, or throws RetailerQuotaError without counting it. */
  async reserve(endpoint: KrogerEndpoint, amount = 1): Promise<void> {
    const now = this.#now();
    const ceiling = this.ceiling(endpoint);
    const day = utcDay(now);
    const result = await this.#store.consume(this.#retailer, endpoint, day, ceiling, amount);
    this.#known.set(`${endpoint}|${day}`, result.used);
    if (!result.allowed) {
      throw new RetailerQuotaError(
        this.#retailer,
        endpoint,
        result.used,
        this.#limits[endpoint],
        nextUtcMidnight(now).toISOString(),
      );
    }
  }

  /**
   * Learns from the retailer's own rate-limit headers after a call: a lower daily limit than ours
   * replaces ours, and a usage count higher than ours (calls from before this table existed, or a
   * process that did not count) raises ours. A 429 marks the endpoint spent for the day.
   */
  async observe(endpoint: KrogerEndpoint, status: number, headers: HeaderSource): Promise<void> {
    const day = utcDay(this.#now());
    const headerLimit = Number(headers.get("x-ratelimit-limit-day"));
    const remaining = Number(headers.get("x-ratelimit-remaining-day"));
    if (Number.isFinite(headerLimit) && headerLimit > 0 && headerLimit < this.#limits[endpoint]) {
      this.#limits[endpoint] = headerLimit;
    }
    if (status === 429) {
      await this.#store.raiseTo(this.#retailer, endpoint, day, this.ceiling(endpoint));
      return;
    }
    if (Number.isFinite(headerLimit) && headerLimit > 0 && Number.isFinite(remaining)) {
      const used = Math.max(0, headerLimit - remaining);
      const key = `${endpoint}|${day}`;
      if (used > (this.#known.get(key) ?? 0)) {
        await this.#store.raiseTo(this.#retailer, endpoint, day, used);
        this.#known.set(key, used);
      }
    }
  }

  quotaError(endpoint: KrogerEndpoint): RetailerQuotaError {
    const now = this.#now();
    return new RetailerQuotaError(
      this.#retailer,
      endpoint,
      this.ceiling(endpoint),
      this.#limits[endpoint],
      nextUtcMidnight(now).toISOString(),
    );
  }
}
