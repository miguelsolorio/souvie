// The only module that imports supabase-js at runtime, so Vitest can mock it
// (vi.mock("./client.ts")) without resolving the package.
export { createClient } from "@supabase/supabase-js";
