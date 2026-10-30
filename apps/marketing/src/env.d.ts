/// <reference types="astro/client" />

// Public build-time variables. Names match .env.example so one .env.local feeds every app.
interface ImportMetaEnv {
  readonly EXPO_PUBLIC_SUPABASE_URL?: string;
  readonly EXPO_PUBLIC_SUPABASE_ANON_KEY?: string;
  readonly EXPO_PUBLIC_POSTHOG_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
