// A small stand-in for the Supabase API, for the browser tests (WS13). It is not a copy of
// PostgREST: it answers the calls the planner, the grocery list and a shopping run make, from rows
// the test hands it, and it records every write so a test can check what the app sent.
//
// Nothing here talks to a real project. The export under test is built with
// EXPO_PUBLIC_SUPABASE_URL = FAKE_SUPABASE_URL (a loopback address nothing listens on), and
// Playwright answers every request to that address before it leaves the browser. The hosted
// project is never touched.
//
// What it understands of PostgREST:
//   * GET  /rest/v1/<table>   filters eq, neq, is, in, gt, gte, lt, lte on top-level columns; order;
//                             limit; the object form (single and maybeSingle); embedded selects are
//                             ignored, so a row carries its embedded rows itself.
//   * POST /rest/v1/<table>   insert, and upsert by `id` when the Prefer header says merge or ignore.
//   * PATCH and DELETE        by the same filters.
//   * /rest/v1/rpc/<name>     rows registered with `rpc()`.
// Anything else is recorded in `unhandled` and answered with an empty 200, so a test can assert
// that the app asked for nothing it did not expect.

import type { Page, Route } from "@playwright/test";

export const FAKE_SUPABASE_URL = "http://127.0.0.1:54321";
export const FAKE_ANON_KEY = "fake-anon-key-for-browser-tests";

export type FakeRow = Record<string, unknown>;

export interface RecordedRequest {
  method: string;
  /** "meal_plan_entries" for /rest/v1/meal_plan_entries, "rpc/<name>" for a function. */
  table: string;
  query: URLSearchParams;
  body: unknown;
}

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
  "access-control-allow-headers":
    "authorization, apikey, content-type, x-client-info, prefer, accept, accept-profile, content-profile, range, x-supabase-api-version",
  "access-control-expose-headers": "content-range, content-type",
};

const RESERVED_QUERY_KEYS = new Set([
  "select",
  "order",
  "limit",
  "offset",
  "on_conflict",
  "columns",
]);

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : 1;
}

/** Whether `row[column]` passes one PostgREST filter such as `eq.abc` or `is.null`. */
export function matchesFilter(row: FakeRow, column: string, filter: string): boolean {
  const dot = filter.indexOf(".");
  if (dot === -1) return true;
  const operator = filter.slice(0, dot);
  const operand = filter.slice(dot + 1);
  const value = row[column];
  const text = value === null || value === undefined ? null : String(value);
  switch (operator) {
    case "eq":
      return text === operand;
    case "neq":
      return text !== operand;
    case "is":
      if (operand === "null") return value === null || value === undefined;
      return String(value) === operand;
    case "in": {
      const list = operand.replace(/^\(|\)$/g, "").split(",");
      return text !== null && list.includes(text);
    }
    case "gt":
      return compare(value, operand) > 0;
    case "gte":
      return compare(value, operand) >= 0;
    case "lt":
      return compare(value, operand) < 0;
    case "lte":
      return compare(value, operand) <= 0;
    default:
      return true;
  }
}

export class FakeSupabase {
  readonly tables = new Map<string, FakeRow[]>();
  readonly requests: RecordedRequest[] = [];
  /** Requests nothing was registered for: "GET /rest/v1/foo?...". */
  readonly unhandled: string[] = [];
  private readonly rpcs = new Map<string, (args: unknown) => unknown>();
  private readonly functions = new Map<string, (body: unknown) => unknown>();
  /** Where /auth/v1/authorize sends the browser back to, set by the sign-in test. */
  private appOrigin = "http://127.0.0.1:4173";
  signedInUser: FakeRow | null = null;

  seed(table: string, rows: FakeRow[]): this {
    this.tables.set(table, structuredClone(rows));
    return this;
  }

  rows(table: string): FakeRow[] {
    return this.tables.get(table) ?? [];
  }

  rpc(name: string, answer: (args: unknown) => unknown): this {
    this.rpcs.set(name, answer);
    return this;
  }

  edgeFunction(name: string, answer: (body: unknown) => unknown): this {
    this.functions.set(name, answer);
    return this;
  }

  /** Every recorded write (POST, PATCH, DELETE) to a table. */
  writes(table: string): RecordedRequest[] {
    return this.requests.filter((r) => r.table === table && r.method !== "GET");
  }

  /** Starts answering. Call before `page.goto`. */
  async install(page: Page, options: { appOrigin?: string } = {}): Promise<void> {
    if (options.appOrigin) this.appOrigin = options.appOrigin;

    await page.route(`${FAKE_SUPABASE_URL}/**`, (route) => this.handle(route));

    // Realtime: accept the socket and say yes to every join, so the app believes it is live.
    await page.routeWebSocket(/\/realtime\/v1\/websocket/, (socket) => {
      socket.onMessage((raw) => {
        let message: unknown;
        try {
          message = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (Array.isArray(message)) {
          const [joinRef, ref, topic, event] = message as [string, string, string, string];
          if (event === "heartbeat") {
            socket.send(
              JSON.stringify([null, ref, "phoenix", "phx_reply", { status: "ok", response: {} }]),
            );
          } else if (event === "phx_join") {
            socket.send(
              JSON.stringify([
                joinRef,
                ref,
                topic,
                "phx_reply",
                { status: "ok", response: { postgres_changes: [] } },
              ]),
            );
          }
          return;
        }
        const object = message as {
          topic?: string;
          event?: string;
          ref?: string;
          join_ref?: string;
        };
        if (object.event === "heartbeat") {
          socket.send(
            JSON.stringify({
              topic: "phoenix",
              event: "phx_reply",
              ref: object.ref,
              payload: { status: "ok", response: {} },
            }),
          );
        } else if (object.event === "phx_join") {
          socket.send(
            JSON.stringify({
              topic: object.topic,
              event: "phx_reply",
              ref: object.ref,
              payload: { status: "ok", response: { postgres_changes: [] } },
            }),
          );
        }
      });
    });
  }

  private json(route: Route, status: number, body: unknown, extra: Record<string, string> = {}) {
    return route.fulfill({
      status,
      headers: { ...CORS_HEADERS, "content-type": "application/json", ...extra },
      body: body === undefined ? "" : JSON.stringify(body),
    });
  }

  private async handle(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (method === "OPTIONS") {
      await route.fulfill({ status: 204, headers: CORS_HEADERS });
      return;
    }

    let body: unknown;
    try {
      body = request.postDataJSON();
    } catch {
      body = request.postData() ?? undefined;
    }

    if (url.pathname.startsWith("/auth/v1/")) return this.auth(route, url, method, body);
    if (url.pathname.startsWith("/functions/v1/")) {
      const name = url.pathname.slice("/functions/v1/".length);
      const answer = this.functions.get(name);
      this.requests.push({ method, table: `functions/${name}`, query: url.searchParams, body });
      if (!answer) {
        this.unhandled.push(`${method} ${url.pathname}`);
        return void (await this.json(route, 200, {}));
      }
      return void (await this.json(route, 200, answer(body)));
    }
    if (url.pathname.startsWith("/rest/v1/")) return this.rest(route, url, method, body);

    this.unhandled.push(`${method} ${url.pathname}${url.search}`);
    await this.json(route, 200, {});
  }

  // --- auth -------------------------------------------------------------------------------

  private async auth(route: Route, url: URL, method: string, body: unknown): Promise<void> {
    const path = url.pathname.slice("/auth/v1/".length);
    this.requests.push({ method, table: `auth/${path}`, query: url.searchParams, body });

    if (path === "authorize") {
      // The identity provider's part: send the browser straight back with a code.
      const redirectTo = url.searchParams.get("redirect_to") ?? `${this.appOrigin}/callback`;
      await route.fulfill({
        status: 302,
        headers: { location: `${redirectTo}?code=fake-auth-code`, "cache-control": "no-store" },
      });
      return;
    }
    if (path === "token") {
      await this.json(route, 200, this.sessionFor(this.signedInUser));
      return;
    }
    if (path === "user") {
      await this.json(route, 200, this.signedInUser ?? {});
      return;
    }
    if (path === "logout") {
      await route.fulfill({ status: 204, headers: CORS_HEADERS });
      return;
    }
    this.unhandled.push(`${method} ${url.pathname}${url.search}`);
    await this.json(route, 200, {});
  }

  /** A session for `user`, as /auth/v1/token returns it. */
  sessionFor(user: FakeRow | null): unknown {
    return makeSession(user ?? { id: "00000000-0000-4000-8000-000000000000" });
  }

  // --- PostgREST ----------------------------------------------------------------------------

  private async rest(route: Route, url: URL, method: string, body: unknown): Promise<void> {
    const name = url.pathname.slice("/rest/v1/".length);
    const query = url.searchParams;
    const accept = route.request().headers().accept ?? "";
    const prefer = route.request().headers().prefer ?? "";
    this.requests.push({ method, table: name, query, body });

    if (name.startsWith("rpc/")) {
      const answer = this.rpcs.get(name.slice(4));
      if (!answer) {
        this.unhandled.push(`${method} /rest/v1/${name}`);
        return void (await this.json(route, 200, null));
      }
      return void (await this.json(route, 200, answer(body)));
    }

    const rows = this.tables.get(name);
    if (!rows) {
      this.unhandled.push(`${method} /rest/v1/${name}?${query.toString()}`);
      if (method === "GET") return void (await this.respondRows(route, accept, []));
      return void (await route.fulfill({ status: 204, headers: CORS_HEADERS }));
    }

    const selected = () => this.select(rows, query);

    switch (method) {
      case "GET":
      case "HEAD":
        return void (await this.respondRows(route, accept, selected()));
      case "POST": {
        const incoming = (Array.isArray(body) ? body : [body]) as FakeRow[];
        const merge = prefer.includes("resolution=merge-duplicates");
        const ignore = prefer.includes("resolution=ignore-duplicates");
        const written: FakeRow[] = [];
        for (const row of incoming) {
          const at = rows.findIndex(
            (existing) => existing.id !== undefined && existing.id === row.id,
          );
          if (at === -1) {
            rows.push({ ...row });
            written.push(row);
          } else if (merge) {
            rows[at] = { ...rows[at], ...row };
            written.push(rows[at] as FakeRow);
          } else if (!ignore) {
            return void (await this.json(route, 409, { code: "23505", message: "duplicate key" }));
          }
        }
        if (prefer.includes("return=representation")) {
          return void (await this.json(route, 201, written));
        }
        return void (await route.fulfill({ status: 201, headers: CORS_HEADERS }));
      }
      case "PATCH": {
        const hit = selected();
        for (const row of hit) Object.assign(row, body as FakeRow);
        if (prefer.includes("return=representation"))
          return void (await this.json(route, 200, hit));
        return void (await route.fulfill({ status: 204, headers: CORS_HEADERS }));
      }
      case "DELETE": {
        const hit = new Set(selected());
        this.tables.set(
          name,
          rows.filter((row) => !hit.has(row)),
        );
        if (prefer.includes("return=representation"))
          return void (await this.json(route, 200, [...hit]));
        return void (await route.fulfill({ status: 204, headers: CORS_HEADERS }));
      }
      default:
        this.unhandled.push(`${method} /rest/v1/${name}`);
        return void (await route.fulfill({ status: 204, headers: CORS_HEADERS }));
    }
  }

  private select(rows: FakeRow[], query: URLSearchParams): FakeRow[] {
    let result = rows.filter((row) => {
      for (const [key, value] of query) {
        // Embedded-resource filters ("households.deleted_at") and the reserved keys are not columns.
        if (RESERVED_QUERY_KEYS.has(key) || key.includes(".")) continue;
        if (!matchesFilter(row, key, value)) return false;
      }
      return true;
    });

    const order = query.get("order");
    if (order) {
      const keys = order.split(",").map((part) => {
        const [column = "", direction = "asc"] = part.split(".");
        return { column, sign: direction === "desc" ? -1 : 1 };
      });
      result = [...result].sort((a, b) => {
        for (const { column, sign } of keys) {
          const difference = compare(a[column], b[column]);
          if (difference !== 0) return difference * sign;
        }
        return 0;
      });
    }
    const limit = query.get("limit");
    return limit ? result.slice(0, Number(limit)) : result;
  }

  private async respondRows(route: Route, accept: string, rows: FakeRow[]): Promise<void> {
    const range = rows.length === 0 ? "*/0" : `0-${rows.length - 1}/*`;
    if (accept.includes("application/vnd.pgrst.object+json")) {
      if (rows.length !== 1) {
        await this.json(
          route,
          406,
          {
            code: "PGRST116",
            details: `The result contains ${rows.length} rows`,
            hint: null,
            message: "Cannot coerce the result to a single JSON object",
          },
          { "content-range": range },
        );
        return;
      }
      await this.json(route, 200, rows[0], { "content-range": range });
      return;
    }
    await this.json(route, 200, rows, { "content-range": range });
  }
}

// --- sessions --------------------------------------------------------------------------------

function base64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

/** The instant the page's clock is fixed to (see `signedIn`), in epoch seconds. */
export function epochSeconds(at: Date): number {
  return Math.floor(at.getTime() / 1000);
}

/**
 * A session shaped like GoTrue's. The access token is a JWT with no real signature: the app
 * never verifies it, and only the fake answers requests that carry it.
 */
export function makeSession(user: FakeRow, now: Date = new Date()) {
  const exp = epochSeconds(now) + 60 * 60;
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ sub: user.id, role: "authenticated", aud: "authenticated", exp }),
  );
  return {
    access_token: `${header}.${payload}.fake-signature`,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: exp,
    refresh_token: "fake-refresh-token",
    user: {
      aud: "authenticated",
      role: "authenticated",
      app_metadata: { provider: "email", providers: ["email"] },
      user_metadata: {},
      created_at: "2026-10-01T12:00:00.000Z",
      ...user,
    },
  };
}

/** localStorage key supabase-js keeps the session under: `sb-<first label of the host>-auth-token`. */
export function sessionStorageKey(supabaseUrl: string = FAKE_SUPABASE_URL): string {
  return `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`;
}
