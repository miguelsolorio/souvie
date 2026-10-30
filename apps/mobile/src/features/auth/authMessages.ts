// Turns auth failures into text a person can act on. Pure, so Vitest can run it.

/** Raised when a sign-in redirect comes back with an error or without a code. */
export class AuthCallbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthCallbackError";
  }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isPlausibleEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}

export function describeAuthError(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const lower = message.toLowerCase();

  if (lower.includes("expired") || lower.includes("otp_expired")) {
    return "That link or code has expired. Request a new one.";
  }
  if (lower.includes("invalid") && (lower.includes("token") || lower.includes("code"))) {
    return "That code is not right. Check it and try again.";
  }
  if (
    lower.includes("rate limit") ||
    lower.includes("too many") ||
    lower.includes("security purposes")
  ) {
    return "Too many attempts. Wait a minute and try again.";
  }
  if (
    lower.includes("network") ||
    lower.includes("failed to fetch") ||
    lower.includes("timed out")
  ) {
    return "Could not reach the server. Check your connection and try again.";
  }
  if (lower.includes("provider is not enabled") || lower.includes("unsupported provider")) {
    return "That sign-in method is not turned on for this project yet.";
  }
  if (error instanceof AuthCallbackError && message) return message;
  return "Sign-in did not work. Try again.";
}
