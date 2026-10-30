// An invite link opened while signed out has to survive the sign-in round trip, including a full
// page reload on web (OAuth redirects leave the app). The token waits in auth storage until the
// join screen consumes it. The storage is injectable so tests can use a fake.
import type { SupportedStorage } from "@supabase/supabase-js";
import { authStorage } from "../../lib/authStorage";
import { isValidInviteToken } from "./links";

export const PENDING_INVITE_KEY = "mp-pending-invite";

export async function getPendingInvite(
  storage: SupportedStorage = authStorage,
): Promise<string | null> {
  const value = await storage.getItem(PENDING_INVITE_KEY);
  return isValidInviteToken(value) ? value : null;
}

export async function setPendingInvite(
  token: string,
  storage: SupportedStorage = authStorage,
): Promise<void> {
  if (!isValidInviteToken(token)) return;
  await storage.setItem(PENDING_INVITE_KEY, token);
}

export async function clearPendingInvite(storage: SupportedStorage = authStorage): Promise<void> {
  await storage.removeItem(PENDING_INVITE_KEY);
}
