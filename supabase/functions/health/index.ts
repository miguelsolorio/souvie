// Liveness and version probe for the Supabase stack (WS00).
// GET or POST /functions/v1/health -> { "ok": true, "version": "0.1.0" }
// Public: verify_jwt = false in supabase/config.toml. It reads nothing and returns no data.
// No Deno globals, so Vitest can import this file directly (index.test.ts).

/** Keep in step with the root package.json version. */
export const VERSION = "0.1.0";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function handleHealth(req: Request): Response {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "GET" && req.method !== "POST") {
    return Response.json(
      { ok: false, error: "method_not_allowed" },
      { status: 405, headers: { ...CORS_HEADERS, Allow: "GET, POST, OPTIONS" } },
    );
  }
  return Response.json(
    { ok: true, version: VERSION },
    { headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } },
  );
}

export default { fetch: handleHealth };
