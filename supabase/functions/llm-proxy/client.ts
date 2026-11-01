// The only module that imports supabase-js at runtime, so Vitest can leave it out (the tests build
// a Runtime from fakes instead, see index.test.ts).
export { createClient } from "@supabase/supabase-js";
