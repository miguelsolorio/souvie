// Typed calls for the identity RPCs and tables (WS01). Screens use these through TanStack Query
// mutations. Errors from the database are mapped to IdentityError so the UI never parses text.
import { CreateHouseholdInput, type HouseholdRosterEntry, ProfileUpdateInput } from "@mp/core";
import type { MpClient } from "./client";

/** The error codes the identity functions raise (supabase/migrations/*_identity_functions.sql). */
export const IDENTITY_ERROR_CODES = [
  "not_authenticated",
  "invalid_name",
  "not_owner",
  "not_a_member",
  "invite_not_found",
  "invite_used",
  "invite_expired",
] as const;
export type IdentityErrorCode = (typeof IDENTITY_ERROR_CODES)[number] | "unknown";

export class IdentityError extends Error {
  readonly code: IdentityErrorCode;

  constructor(code: IdentityErrorCode, message?: string) {
    super(message ?? code);
    this.name = "IdentityError";
    this.code = code;
  }
}

/** Maps a PostgREST error to an IdentityError by the code the function put in its message. */
export function toIdentityError(error: { message?: string | null }): IdentityError {
  const message = (error.message ?? "").trim();
  const code = IDENTITY_ERROR_CODES.find((c) => c === message);
  return code ? new IdentityError(code) : new IdentityError("unknown", message || "unknown error");
}

/** Short text for each code, written for the person using the app. */
export const IDENTITY_ERROR_MESSAGES: Record<IdentityErrorCode, string> = {
  not_authenticated: "Your session has ended. Sign in again.",
  invalid_name: "Names must be 1 to 80 characters.",
  not_owner: "Only the household owner can do that.",
  not_a_member: "You are not a member of that household.",
  invite_not_found: "This invite link is not valid.",
  invite_used: "This invite link has already been used. Ask for a new one.",
  invite_expired: "This invite link has expired. Ask for a new one.",
  unknown: "Something went wrong. Try again.",
};

export function identityErrorMessage(error: unknown): string {
  if (error instanceof IdentityError) return IDENTITY_ERROR_MESSAGES[error.code];
  return IDENTITY_ERROR_MESSAGES.unknown;
}

/** Creates a household and makes the caller its owner. Returns the household id. */
export async function createHousehold(client: MpClient, name: string): Promise<string> {
  const input: CreateHouseholdInput = CreateHouseholdInput.parse({ name });
  const { data, error } = await client.rpc("create_household", { name: input.name });
  if (error) throw toIdentityError(error);
  return data;
}

/** Owner only. Returns a single-use token that is valid for 7 days. */
export async function createInvite(client: MpClient, householdId: string): Promise<string> {
  const { data, error } = await client.rpc("create_invite", { household_id: householdId });
  if (error) throw toIdentityError(error);
  return data;
}

/** Joins the invite's household as a member. Returns the household id. */
export async function redeemInvite(client: MpClient, token: string): Promise<string> {
  const { data, error } = await client.rpc("redeem_invite", { token });
  if (error) throw toIdentityError(error);
  return data;
}

export async function leaveHousehold(client: MpClient, householdId: string): Promise<void> {
  const { error } = await client.rpc("leave_household", { household_id: householdId });
  if (error) throw toIdentityError(error);
}

/** The roster with names and avatars. Housemates read profiles only through this. */
export async function listHouseholdMembers(
  client: MpClient,
  householdId: string,
): Promise<HouseholdRosterEntry[]> {
  const { data, error } = await client.rpc("list_household_members", {
    household_id: householdId,
  });
  if (error) throw toIdentityError(error);
  // The generated type cannot say these columns may be null; the SQL can return null names.
  return (data ?? []).map((row) => ({
    user_id: row.user_id,
    role: row.role,
    display_name: row.display_name ?? null,
    avatar_url: row.avatar_url ?? null,
    joined_at: row.joined_at,
  }));
}

/** Owner only. Row Level Security rejects anyone else, which shows up as zero rows updated. */
export async function renameHousehold(
  client: MpClient,
  householdId: string,
  name: string,
): Promise<void> {
  const input = CreateHouseholdInput.parse({ name });
  const { data, error } = await client
    .from("households")
    .update({ name: input.name })
    .eq("id", householdId)
    .select("id");
  if (error) throw toIdentityError(error);
  if (!data || data.length === 0) throw new IdentityError("not_owner");
}

/** Owner only: removes another member. Leaving yourself is `leaveHousehold`. */
export async function removeMember(
  client: MpClient,
  householdId: string,
  userId: string,
): Promise<void> {
  const { data, error } = await client
    .from("household_members")
    .delete()
    .eq("household_id", householdId)
    .eq("user_id", userId)
    .select("user_id");
  if (error) throw toIdentityError(error);
  if (!data || data.length === 0) throw new IdentityError("not_owner");
}

/** Updates the caller's display name. */
export async function updateDisplayName(
  client: MpClient,
  userId: string,
  displayName: string,
): Promise<void> {
  const input: ProfileUpdateInput = ProfileUpdateInput.parse({ display_name: displayName });
  const { error } = await client
    .from("profiles")
    .update({ display_name: input.display_name })
    .eq("user_id", userId);
  if (error) throw toIdentityError(error);
}

export const AVATAR_BUCKET = "avatars";
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type AvatarContentType = (typeof AVATAR_CONTENT_TYPES)[number];

const EXTENSIONS: Record<AvatarContentType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export function isAvatarContentType(value: string): value is AvatarContentType {
  return (AVATAR_CONTENT_TYPES as readonly string[]).includes(value);
}

/** The object path for a new avatar: <user_id>/<file_id>.<ext>. The bucket policy requires it. */
export function avatarPath(userId: string, fileId: string, contentType: AvatarContentType): string {
  return `${userId}/${fileId}.${EXTENSIONS[contentType]}`;
}

/**
 * Uploads a new avatar to `avatars/<userId>/<fileId>.<ext>`, points the profile at it, and
 * removes the previous file. `fileId` must be unique per upload; pass a random uuid. Returns the
 * stored object path.
 */
export async function uploadAvatar(
  client: MpClient,
  args: {
    userId: string;
    fileId: string;
    bytes: ArrayBuffer | Uint8Array;
    contentType: AvatarContentType;
    previousPath?: string | null;
  },
): Promise<string> {
  const size = args.bytes.byteLength;
  if (size === 0 || size > AVATAR_MAX_BYTES) {
    throw new Error("Pick an image under 2 MB.");
  }
  const path = avatarPath(args.userId, args.fileId, args.contentType);

  const upload = await client.storage
    .from(AVATAR_BUCKET)
    .upload(path, args.bytes, { contentType: args.contentType, upsert: false });
  if (upload.error) throw new Error(upload.error.message);

  const { error } = await client
    .from("profiles")
    .update({ avatar_url: path })
    .eq("user_id", args.userId);
  if (error) {
    // Keep storage and the profile in step: drop the file we could not point at.
    await client.storage.from(AVATAR_BUCKET).remove([path]);
    throw toIdentityError(error);
  }

  if (args.previousPath && args.previousPath !== path) {
    await client.storage.from(AVATAR_BUCKET).remove([args.previousPath]);
  }
  return path;
}

/** A short-lived URL for a stored avatar, or null when there is none or it cannot be read. */
export async function getAvatarUrl(
  client: MpClient,
  path: string | null | undefined,
  expiresInSeconds = 3600,
): Promise<string | null> {
  if (!path) return null;
  const { data, error } = await client.storage
    .from(AVATAR_BUCKET)
    .createSignedUrl(path, expiresInSeconds);
  if (error) return null;
  return data.signedUrl;
}
