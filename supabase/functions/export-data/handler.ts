// Export-my-data (WS01; docs/05-security-privacy.md §Privacy, docs/01-architecture.md).
//
// Returns one JSON document with everything the calling user and their households own at this
// point: profile, memberships, households, rosters, invites, audit events. It runs under the
// caller's own JWT, so RLS decides what is included. There is no service-role path here.
//
// Later workstreams extend it by appending to SECTIONS. WS12 added orders, shopping runs and their
// lines, and meal plan entries. Do not replace this file. This module has no Deno globals and no
// `npm:` imports so Vitest can load it; index.ts wires in supabase-js.

export type Row = Record<string, unknown>;

/**
 * A total order for each table, so the `.range()` pages index.ts walks never repeat or skip a
 * row. Sections that add a table (WS12) add its entry; select() requires one.
 */
export const ORDER = {
  profiles: ["user_id"],
  household_members: ["created_at", "household_id", "user_id"],
  households: ["id"],
  household_invites: ["created_at", "id"],
  audit_events: ["created_at", "id"],
  // WS12. Each is total: the second column is the primary key.
  orders: ["confirmed_at", "id"],
  shopping_runs: ["created_at", "id"],
  shopping_run_items: ["created_at", "id"],
  meal_plan_entries: ["date", "id"],
} as const;

/**
 * The columns of `shopping_runs` the export carries: every column except `transcript` (the tool
 * log, large, and the run's steps are not the household's data) and `cart_snapshot` (the retailer's
 * cart display data, which Kroger's terms end with the session and which is cleared 24 hours after
 * a run closes). A column added to the table later is added here; handler.test.ts compares this
 * list with the generated types and fails until it is.
 */
export const SHOPPING_RUN_COLUMNS = [
  "id",
  "household_id",
  "list_id",
  "connection_id",
  "retailer",
  "store_id",
  "store_name",
  "trigger",
  "status",
  "policy",
  "subtotal_usd",
  "error",
  "progress",
  "created_by",
  "approved_at",
  "approved_by",
  "started_at",
  "finished_at",
  "heartbeat_at",
  "status_changed_at",
  "created_at",
  "updated_at",
] as const;

/**
 * The columns of `shopping_run_items` the export carries: every column except `alternatives`,
 * the other products shown at review, which are retailer search results rather than the
 * household's purchase record (the approved product, quantity and amount stay).
 */
export const SHOPPING_RUN_ITEM_COLUMNS = [
  "id",
  "run_id",
  "household_id",
  "list_item_id",
  "position",
  "display_name",
  "section",
  "product_id",
  "upc",
  "product_name",
  "size",
  "qty",
  "unit_price_usd",
  "line_total_usd",
  "status",
  "user_decision",
  "flags",
  "reason",
  "delta_sent",
  "cart_qty",
  "sent_at",
  "delta_result",
  "created_at",
  "updated_at",
] as const;

/** The few things the export needs from a database client. index.ts implements it. */
export interface ExportSource {
  /**
   * All rows of a table matching every `eq` filter, paged past the API row limit in the given
   * `order` (column names, ascending). The order must be total or pages can overlap. `columns`
   * names the columns to read; leave it out for all of them.
   */
  select(
    table: string,
    eq: Record<string, string>,
    order: readonly string[],
    columns?: readonly string[],
  ): Promise<Row[]>;
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

/**
 * An invite token is a bearer secret: anyone holding an unused one can join the household. The
 * export is a file people save and share, so the record of an invite stays but its token does not.
 */
export function redactInvite(invite: Row): Row {
  return { ...invite, token: "[redacted]" };
}

/**
 * Every row of one table for each of the caller's households, as one list. The rows carry their
 * household_id. RLS decides what the caller may read; the household filter only narrows the query.
 */
function perHousehold(
  key: string,
  table: keyof typeof ORDER,
  columns?: readonly string[],
): ExportSection {
  return {
    key,
    async collect({ source, householdIds }) {
      const out: Row[] = [];
      for (const id of householdIds) {
        out.push(...(await source.select(table, { household_id: id }, ORDER[table], columns)));
      }
      return out;
    },
  };
}

export const SECTIONS: ExportSection[] = [
  {
    key: "profile",
    async collect({ source, userId }) {
      const rows = await source.select("profiles", { user_id: userId }, ORDER.profiles);
      return rows[0] ?? null;
    },
  },
  {
    key: "memberships",
    collect: ({ source, userId }) =>
      source.select("household_members", { user_id: userId }, ORDER.household_members),
  },
  {
    key: "households",
    async collect({ source, householdIds }) {
      const out: unknown[] = [];
      for (const id of householdIds) {
        const [households, members, roster, invites, auditEvents] = await Promise.all([
          source.select("households", { id }, ORDER.households),
          source.select("household_members", { household_id: id }, ORDER.household_members),
          source.rpc("list_household_members", { household_id: id }),
          // Owners only: RLS returns nothing to a plain member.
          source.select("household_invites", { household_id: id }, ORDER.household_invites),
          source.select("audit_events", { household_id: id }, ORDER.audit_events),
        ]);
        out.push({
          household: households[0] ?? null,
          members,
          roster,
          invites: invites.map(redactInvite),
          audit_events: auditEvents,
        });
      }
      return out;
    },
  },
  // WS12: what the household bought and cooked. Orders are the household's own record of what it
  // placed; runs and their lines are the ledger behind them (no transcript, cart snapshot, or
  // search alternatives, see the column lists above); entries are the meal plan.
  perHousehold("orders", "orders"),
  perHousehold("shopping_runs", "shopping_runs", SHOPPING_RUN_COLUMNS),
  perHousehold("shopping_run_items", "shopping_run_items", SHOPPING_RUN_ITEM_COLUMNS),
  perHousehold("meal_plan_entries", "meal_plan_entries"),
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
      const memberships = await source.select(
        "household_members",
        { user_id: user.id },
        ORDER.household_members,
      );
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
        "Content-Disposition": `attachment; filename="souvie-export-${day}.json"`,
      });
    } catch (error) {
      console.error("export-data failed", error);
      return json({ ok: false, error: "export_failed" }, 500);
    }
  };
}
