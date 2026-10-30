// Public, build-time configuration. Expo inlines EXPO_PUBLIC_* values into the bundle only
// when the code reads `process.env.NAME` directly, so keep these reads literal.
// Secrets never go here: anything EXPO_PUBLIC_ ships to every device.
export const publicEnv = {
  supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL,
  supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
  // Origin of the deployed web app, used to build invite links (WS01). Empty in a fresh clone.
  webOrigin: process.env.EXPO_PUBLIC_WEB_ORIGIN,
  // PostHog is wired in WS15. WS00 only reads the variable.
  posthogKey: process.env.EXPO_PUBLIC_POSTHOG_KEY,
};

export interface SupabaseEnv {
  url: string;
  anonKey: string;
}

/**
 * Returns the Supabase settings, or null when either value is missing so the app can still
 * render (static export, CI, a fresh clone). Throws when the URL is set but malformed.
 */
export function readSupabaseEnv(source: {
  supabaseUrl?: string | undefined;
  supabaseAnonKey?: string | undefined;
}): SupabaseEnv | null {
  const url = source.supabaseUrl?.trim();
  const anonKey = source.supabaseAnonKey?.trim();
  if (!url || !anonKey) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`EXPO_PUBLIC_SUPABASE_URL is not a valid URL: "${url}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`EXPO_PUBLIC_SUPABASE_URL must be http or https: "${url}"`);
  }
  return { url, anonKey };
}
