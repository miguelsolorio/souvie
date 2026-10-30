// Typed retailer errors. Callers branch on the class, never on message text. WS09 pauses a run on
// RetailerQuotaError, flips the connection to needs_reauth on RetailerAuthError, and hides a tool
// on RetailerNotSupportedError.
import type { RetailerId } from "./types.ts";

export class RetailerError extends Error {
  readonly retailer: RetailerId | null;
  /** A stable, machine-readable reason. */
  readonly code: string;

  constructor(retailer: RetailerId | null, code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RetailerError";
    this.retailer = retailer;
    this.code = code;
  }
}

export type RetailerAuthReason =
  | "unauthorized"
  | "invalid_grant"
  | "missing_token"
  | "invalid_state"
  | "expired_state"
  | "state_mismatch"
  | "app_credentials";

/** The retailer refused our credentials. `needsReauth` means the user has to connect again. */
export class RetailerAuthError extends RetailerError {
  readonly reason: RetailerAuthReason;
  readonly connectionId: string | null;
  readonly needsReauth: boolean;

  constructor(
    retailer: RetailerId,
    reason: RetailerAuthReason,
    message: string,
    opts: { connectionId?: string | null; needsReauth?: boolean; cause?: unknown } = {},
  ) {
    super(
      retailer,
      `auth_${reason}`,
      message,
      opts.cause === undefined ? {} : { cause: opts.cause },
    );
    this.name = "RetailerAuthError";
    this.reason = reason;
    this.connectionId = opts.connectionId ?? null;
    this.needsReauth = opts.needsReauth ?? false;
  }
}

/**
 * The daily call budget for an endpoint is (nearly) spent. Thrown before the network call, at 95%
 * of the quota, so callers can pause instead of failing on a 429.
 */
export class RetailerQuotaError extends RetailerError {
  readonly endpoint: string;
  readonly used: number;
  readonly limit: number;
  /** ISO timestamp when the budget resets (UTC midnight for Kroger). */
  readonly resetsAt: string;

  constructor(
    retailer: RetailerId,
    endpoint: string,
    used: number,
    limit: number,
    resetsAt: string,
  ) {
    super(
      retailer,
      "quota_exhausted",
      `${retailer} ${endpoint} quota reached: ${used} of ${limit} calls today. Resets at ${resetsAt}.`,
    );
    this.name = "RetailerQuotaError";
    this.endpoint = endpoint;
    this.used = used;
    this.limit = limit;
    this.resetsAt = resetsAt;
  }
}

/** The adapter cannot do this. Check `capabilities` first; this is the backstop. */
export class RetailerNotSupportedError extends RetailerError {
  readonly operation: string;

  constructor(retailer: RetailerId | null, operation: string, message?: string) {
    super(
      retailer,
      "not_supported",
      message ?? `${retailer ?? "this retailer"} does not support ${operation}`,
    );
    this.name = "RetailerNotSupportedError";
    this.operation = operation;
  }
}

/** The retailer answered with an error we do not map to auth or quota. */
export class RetailerRequestError extends RetailerError {
  readonly status: number;
  /** The retailer's own error code when it sent one, for example "PRODUCT-2017". */
  readonly retailerCode: string | null;

  constructor(
    retailer: RetailerId,
    status: number,
    message: string,
    opts: { retailerCode?: string | null; cause?: unknown } = {},
  ) {
    super(
      retailer,
      `http_${status}`,
      message,
      opts.cause === undefined ? {} : { cause: opts.cause },
    );
    this.name = "RetailerRequestError";
    this.status = status;
    this.retailerCode = opts.retailerCode ?? null;
  }
}

/** A display field no longer matches what the retailer returned (Kroger terms; kroger/terms.ts). */
export class RetailerTermsError extends RetailerError {
  readonly field: string;

  constructor(retailer: RetailerId, field: string, message: string) {
    super(retailer, "display_changed", message);
    this.name = "RetailerTermsError";
    this.field = field;
  }
}

export function isRetailerError(value: unknown): value is RetailerError {
  return value instanceof RetailerError;
}
