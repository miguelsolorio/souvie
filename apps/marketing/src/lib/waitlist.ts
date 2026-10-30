// Waitlist form logic, kept free of the DOM and of supabase-js so it can be unit tested.
// The table and its constraints: supabase/migrations/*_waitlist.sql.

export const messages = {
  joined: "You're on the list. We'll email you when your stores are live.",
  duplicate: "You're already on the list.",
  invalidEmail: "Enter a valid email address.",
  invalidZip: "Zip codes have five digits.",
  unavailable: "The waitlist isn't open yet. Check back soon.",
  error: "Something went wrong. Try again in a minute.",
} as const;

export type WaitlistStatus =
  | "joined"
  | "duplicate"
  | "invalid-email"
  | "invalid-zip"
  | "unavailable"
  | "error";

export interface WaitlistResult {
  status: WaitlistStatus;
  message: string;
}

export interface WaitlistInput {
  email: string;
  zip?: string;
  source?: string;
  /** The hidden field. Real visitors never fill it. */
  honeypot?: string;
}

export interface WaitlistRow {
  email: string;
  zip: string | null;
  source: string;
}

/** The slice of supabase-js the form uses, so tests can pass a stub. */
export interface WaitlistClient {
  from(table: "waitlist"): {
    insert(row: WaitlistRow): PromiseLike<{ error: { code?: string; message: string } | null }>;
  };
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ZIP = /^\d{5}$/;

export function isValidEmail(email: string): boolean {
  return email.length >= 3 && email.length <= 254 && EMAIL.test(email);
}

/**
 * Turns `?ref=` or `?utm_source=` into a value the table accepts (`^[a-z0-9._-]{1,64}$`).
 * Anything unusable becomes "landing".
 */
export function normalizeSource(raw: string | null | undefined): string {
  const cleaned = (raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return cleaned || "landing";
}

function result(status: WaitlistStatus): WaitlistResult {
  const message = {
    joined: messages.joined,
    duplicate: messages.duplicate,
    "invalid-email": messages.invalidEmail,
    "invalid-zip": messages.invalidZip,
    unavailable: messages.unavailable,
    error: messages.error,
  }[status];
  return { status, message };
}

/**
 * Validates the form, then inserts one row. `getClient` returns null when the site was built
 * without Supabase settings. A filled honeypot gets the normal success message and no insert,
 * so a bot learns nothing.
 */
export async function submitWaitlist(
  input: WaitlistInput,
  getClient: () => Promise<WaitlistClient | null>,
): Promise<WaitlistResult> {
  if (input.honeypot && input.honeypot.trim() !== "") return result("joined");

  const email = input.email.trim();
  if (!isValidEmail(email)) return result("invalid-email");

  const zip = (input.zip ?? "").trim();
  if (zip !== "" && !ZIP.test(zip)) return result("invalid-zip");

  const client = await getClient();
  if (!client) return result("unavailable");

  try {
    const { error } = await client.from("waitlist").insert({
      email,
      zip: zip === "" ? null : zip,
      source: normalizeSource(input.source),
    });
    if (!error) return result("joined");
    // 23505 is a unique violation: the lowercased email is already there.
    if (error.code === "23505") return result("duplicate");
    return result("error");
  } catch {
    return result("error");
  }
}
