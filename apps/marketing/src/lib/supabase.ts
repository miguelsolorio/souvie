// Loads supabase-js only when someone submits the form, so the landing page itself ships almost
// no JavaScript. The anon key is public by design; the waitlist table is insert-only for anon.

import type { WaitlistClient } from "./waitlist";

export async function loadWaitlistClient(): Promise<WaitlistClient | null> {
  const url = import.meta.env.EXPO_PUBLIC_SUPABASE_URL;
  const key = import.meta.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;

  const { createClient } = await import("@supabase/supabase-js");
  // No session: this page never signs anyone in, so keep it from touching storage or the URL.
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return {
    from: () => ({
      // Default `Prefer: return=minimal`, so the insert needs no select policy.
      insert: (row) => client.from("waitlist").insert(row),
    }),
  };
}
