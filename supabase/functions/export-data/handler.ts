// Export-my-data (WS01; docs/05-security-privacy.md §Privacy, docs/01-architecture.md).
//
// Returns one JSON document with everything the calling user and their households own at this
// point: profile, memberships, households, rosters, invites, audit events. It runs under the
// caller's own JWT, so RLS decides what is included. There is no service-role path here.
//
// Later workstreams extend it by appending to SECTIONS (WS12 adds orders, runs, plan entries).
// Do not replace this file. This module has no Deno globals and no `npm:` imports so Vitest
// can load it; index.ts wires in supabase-js.

export type Row = Record<string, unknown>;

/** The few things the export needs from a database client. index.ts implements it. */
export interface ExportSource {
  /** All rows of a table matching every `eq` filter, paged past the API row limit. */
  select(table: string, eq: Record<string, string>): Promise<Row[]>;
  /** A table-returning RPC. */
  rpc(fn: string, args: Record<string, string>): Promise<Row[]>;
}

export interface ExportContext {
  userId: string;
  email: string | null;
  /** Household ids the caller belongs to, oldest membership first. */
  householdIds: string[];
  source: ExportSource;
}

export interface ExportSection {
  /** Top-level key in the output document. */
  key: string;
  collect(ctx: ExportContext): Promise<unknown>;
}

export const SECTIONS: ExportSection[] = [
  {
    key: "profile",
    async collect({ source, userId }) {
      const rows = await source.select("profiles", { user_id: userId });
      return rows[0] ?? null;
    },
  },
  {
    key: "memberships",
    collect: ({ source, userId }) => source.select("household_members", { user_id: userId }),
  },
  {
    key: "households",
    async collect({ source, householdIds }) {
      const out: unknown[] = [];
      for (const id of householdIds) {
        const [households, members, roster, invites, auditEvents] = await Promise.all([
          source.select("households", { id }),
          source.select("household_members", { household_id: id }),
          source.rpc("list_household_members", { household_id: id }),
          // Owners only: RLS returns nothing to a plain member.
          source.select("household_invites", { household_id: id }),
          source.select("audit_events", { household_id: id }),
        ]);
        out.push({
          household: households[0] ?? null,
          members,
          roster,
          invites,
          audit_events: auditEvents,
        });
      }
      return out;
    },
  },
];

export interface AuthedUser {
  id: string;
  email: string | null;
}

export interface ExportDeps {
  /** Verifies the bearer token and returns its user, or null. */
  authenticate(bearerToken: string): Promise<AuthedUser | null>;
  /** A source that queries as that user. */
  sourceFor(bearerToken: string): ExportSource;
  now(): Date;
  sections?: ExportSection[];
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: { ...CORS_HEADERS, "Cache-Control": "no-store", ...extra },
  });
}

function bearerToken(req: Request): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.get("Authorization") ?? "");
  return match?.[1]?.trim() || null;
}

export function createHandler(deps: ExportDeps): (req: Request) => Promise<Response> {
  const sections = deps.sections ?? SECTIONS;

  return async (req) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (req.method !== "GET" && req.method !== "POST") {
      return json({ ok: false, error: "method_not_allowed" }, 405, { Allow: "GET, POST, OPTIONS" });
    }

    const token = bearerToken(req);
    const user = token ? await deps.authenticate(token) : null;
    if (!token || !user) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }

    try {
      const source = deps.sourceFor(token);
      const memberships = await source.select("household_members", { user_id: user.id });
      const householdIds = memberships
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
        .map((m) => String(m.household_id));

      const ctx: ExportContext = { userId: user.id, email: user.email, householdIds, source };
      const exportedAt = deps.now();
      const doc: Record<string, unknown> = {
        exported_at: exportedAt.toISOString(),
        user: { id: user.id, email: user.email },
      };
      for (const section of sections) {
        doc[section.key] = await section.collect(ctx);
      }

      const day = exportedAt.toISOString().slice(0, 10);
      return json(doc, 200, {
        "Content-Disposition": `attachment; filename="meal-planner-export-${day}.json"`,
      });
    } catch (error) {
      console.error("export-data failed", error);
      return json({ ok: false, error: "export_failed" }, 500);
    }
  };
}
