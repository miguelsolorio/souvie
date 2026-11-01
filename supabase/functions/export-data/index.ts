// export-data Edge Function entry point (WS01). Logic and tests live in handler.ts.
// POST or GET /functions/v1/export-data with the user's bearer token -> JSON export.
// verify_jwt is on in supabase/config.toml; the handler also verifies the token and queries
// with it, so RLS applies. SUPABASE_URL and SUPABASE_ANON_KEY are provided by the platform.

import { createClient } from "@supabase/supabase-js";
import { createHandler, type ExportSource, type Row } from "./handler.ts";

declare const Deno: { env: { get(name: string): string | undefined } };

const PAGE_SIZE = 1000;

function config(): { url: string; anonKey: string } {
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anonKey) throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY must be set");
  return { url, anonKey };
}

function clientFor(token: string) {
  const { url, anonKey } = config();
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function sourceFor(token: string): ExportSource {
  const client = clientFor(token);
  return {
    async select(table, eq, order, columns) {
      const rows: Row[] = [];
      for (let from = 0; ; from += PAGE_SIZE) {
        // The cast keeps supabase-js's result type the same for a column list as for "*".
        let query = client.from(table).select((columns ? columns.join(",") : "*") as "*");
        for (const [column, value] of Object.entries(eq)) query = query.eq(column, value);
        // Without a total order, Postgres may return rows in a different order per page.
        for (const column of order) query = query.order(column, { ascending: true });
        const { data, error } = await query.range(from, from + PAGE_SIZE - 1);
        if (error) throw new Error(`select ${table}: ${error.message}`);
        rows.push(...(data as Row[]));
        if (data.length < PAGE_SIZE) return rows;
      }
    },
    async rpc(fn, args) {
      const { data, error } = await client.rpc(fn, args);
      if (error) throw new Error(`rpc ${fn}: ${error.message}`);
      return (data ?? []) as Row[];
    },
  };
}

const handler = createHandler({
  async authenticate(token) {
    const { data, error } = await clientFor(token).auth.getUser(token);
    if (error || !data.user) return null;
    return { id: data.user.id, email: data.user.email ?? null };
  },
  sourceFor,
  now: () => new Date(),
});

export default { fetch: handler };
