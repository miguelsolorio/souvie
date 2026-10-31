// The only module that imports supabase-js and the Postgres driver at runtime, so Vitest can leave
// it out (the tests build a Runtime from PGlite instead, see handler.test.ts).
import postgres from "postgres";
import type { PgClient } from "./sql.ts";

export { createClient } from "@supabase/supabase-js";

/** A small pool on SUPABASE_DB_URL. `prepare: false` keeps it working behind a transaction pooler. */
export function connect(url: string): PgClient {
  return postgres(url, {
    prepare: false,
    max: 3,
    idle_timeout: 20,
    connect_timeout: 10,
  }) as unknown as PgClient;
}
