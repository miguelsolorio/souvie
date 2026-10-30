import { createClient, type MpClient } from "@mp/db";
import { authStorage } from "./authStorage";
import { publicEnv, readSupabaseEnv } from "./env";

export const supabaseEnv = readSupabaseEnv(publicEnv);
export const isSupabaseConfigured = supabaseEnv !== null;

let client: MpClient | undefined;

/**
 * The app's typed supabase-js client (WS01 moved the wrapper into @mp/db). It uses the anon key,
 * so RLS governs every query, and keeps the auth session in authStorage.
 * Created on first use so the static web export renders without env vars.
 */
export function getSupabase(): MpClient {
  if (!supabaseEnv) {
    throw new Error(
      "Supabase is not configured. Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY in the repo root .env.local.",
    );
  }
  client ??= createClient(supabaseEnv.url, supabaseEnv.anonKey, { storage: authStorage });
  return client;
}
