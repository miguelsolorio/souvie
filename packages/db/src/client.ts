import {
  createClient as createSupabaseClient,
  type SupabaseClient,
  type SupportedStorage,
} from "@supabase/supabase-js";
import type { Database } from "./types.generated";

/** The typed client every app and function in this repo uses. */
export type MpClient = SupabaseClient<Database>;

export interface CreateClientOptions {
  /**
   * Where the auth session is kept: AsyncStorage on native, localStorage on web. Leave it out on
   * a server or in a test and supabase-js keeps the session in memory.
   */
  storage?: SupportedStorage;
}

/**
 * Creates a supabase-js client with the anon key, so Row Level Security governs every query.
 * Never pass the service-role key here (docs/05-security-privacy.md).
 *
 * Auth uses the PKCE flow on every platform, and `detectSessionInUrl` is off: the app exchanges
 * the `code` itself on the callback route (apps/mobile/app/(auth)/callback.tsx), which is the
 * one place that runs on native deep links and web redirects alike.
 */
export function createClient(
  url: string,
  anonKey: string,
  options: CreateClientOptions = {},
): MpClient {
  return createSupabaseClient<Database>(url, anonKey, {
    auth: {
      flowType: "pkce",
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      ...(options.storage ? { storage: options.storage } : {}),
    },
  });
}
