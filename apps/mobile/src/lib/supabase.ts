import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { publicEnv, readSupabaseEnv } from "./env";

export const supabaseEnv = readSupabaseEnv(publicEnv);
export const isSupabaseConfigured = supabaseEnv !== null;

let client: SupabaseClient | undefined;

/**
 * The app's supabase-js client. It uses the anon key, so RLS governs every query.
 * Created on first use so the static web export renders without env vars.
 * WS01 adds session storage and the auth flows; WS01 may move this into packages/db.
 */
export function getSupabase(): SupabaseClient {
  if (!supabaseEnv) {
    throw new Error(
      "Supabase is not configured. Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY in the repo root .env.local.",
    );
  }
  client ??= createClient(supabaseEnv.url, supabaseEnv.anonKey);
  return client;
}
