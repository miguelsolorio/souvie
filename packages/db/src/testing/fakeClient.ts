// A small in-memory stand-in for the slice of supabase-js the planner hooks use, for unit tests.
// It keeps rows in tables and understands select, insert, upsert (ON CONFLICT DO NOTHING or merge),
// update, delete, eq/neq/in filters, order, limit, single/maybeSingle, and a fetch that can fail.
// It is not a database: no RLS, no triggers. The pgTAP file covers those.
import type { MpClient } from "../client";

type Row = Record<string, unknown>;

export interface Failure {
  message: string;
  code?: string;
  /** 0 means the request never got a response (offline). */
  status: number;
  /** The server applied the change but the response was lost on the way back. */
  afterApply?: boolean;
}

export interface RequestLog {
  table: string;
  op: "select" | "insert" | "upsert" | "update" | "delete";
  payload?: unknown;
  options?: unknown;
  filters: Array<[string, string, unknown]>;
  failed: boolean;
}

export const OFFLINE: Failure = { message: "TypeError: Failed to fetch", code: "", status: 0 };

export class FakeServer {
  tables: Record<string, Row[]> = {
    meal_plans: [],
    meal_plan_entries: [],
    recipe_feedback: [],
    recipes: [],
  };
  log: RequestLog[] = [];
  /** Failures to hand out, one per request, before requests start succeeding again. */
  failures: Failure[] = [];
  /** When true every request fails like a dropped connection. */
  offline = false;
  /** Requests wait on this before they run, so a test can look at the app while one is in flight. */
  gate: Promise<void> | undefined;
  /** Called as each request starts, with the log entry it will have. */
  onRequest: ((entry: RequestLog) => void) | undefined;
  private clock = 0;

  now(): string {
    this.clock += 1;
    return new Date(Date.UTC(2026, 9, 30, 12, 0, this.clock)).toISOString();
  }

  nextFailure(): Failure | null {
    if (this.offline) return OFFLINE;
    return this.failures.shift() ?? null;
  }

  requests(table?: string, op?: RequestLog["op"]): RequestLog[] {
    return this.log.filter((r) => (!table || r.table === table) && (!op || r.op === op));
  }
}

const DEFAULTS: Record<string, () => Row> = {
  meal_plans: () => ({}),
  meal_plan_entries: () => ({ status: "planned", notes: null, position: 0, why: null }),
  recipe_feedback: () => ({ rating: null }),
};

class Query implements PromiseLike<unknown> {
  private op: RequestLog["op"] = "select";
  private payload: unknown;
  private options: { onConflict?: string; ignoreDuplicates?: boolean } = {};
  private filters: Array<[string, string, unknown]> = [];
  private orders: Array<[string, boolean]> = [];
  private max: number | undefined;
  private shape: "many" | "one" | "maybe" = "many";
  private returning = false;

  constructor(
    private server: FakeServer,
    private table: string,
  ) {}

  select(_columns?: string) {
    this.returning = true;
    return this;
  }
  insert(payload: unknown) {
    this.op = "insert";
    this.payload = payload;
    return this;
  }
  upsert(payload: unknown, options: { onConflict?: string; ignoreDuplicates?: boolean } = {}) {
    this.op = "upsert";
    this.payload = payload;
    this.options = options;
    return this;
  }
  update(payload: unknown) {
    this.op = "update";
    this.payload = payload;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  eq(column: string, value: unknown) {
    this.filters.push([column, "eq", value]);
    return this;
  }
  neq(column: string, value: unknown) {
    this.filters.push([column, "neq", value]);
    return this;
  }
  in(column: string, values: unknown[]) {
    this.filters.push([column, "in", values]);
    return this;
  }
  order(column: string, options: { ascending?: boolean } = {}) {
    this.orders.push([column, options.ascending !== false]);
    return this;
  }
  limit(count: number) {
    this.max = count;
    return this;
  }
  single() {
    this.shape = "one";
    return this;
  }
  maybeSingle() {
    this.shape = "maybe";
    return this;
  }

  private matches(row: Row): boolean {
    return this.filters.every(([column, op, value]) => {
      const have = row[column];
      if (op === "eq") return have === value;
      if (op === "neq") return have !== value;
      return Array.isArray(value) && value.includes(have);
    });
  }

  private withEmbeds(row: Row): Row {
    if (this.table !== "meal_plan_entries") return row;
    const recipe = this.server.tables.recipes?.find((r) => r.id === row.recipe_id) ?? null;
    return { ...row, recipes: recipe };
  }

  private run(): { data: unknown; error: unknown; status: number } {
    const failure = this.server.nextFailure();
    const entry: RequestLog = {
      table: this.table,
      op: this.op,
      payload: this.payload,
      options: this.options,
      filters: this.filters,
      failed: failure !== null,
    };
    this.server.log.push(entry);
    this.server.onRequest?.(entry);
    if (failure && !failure.afterApply) return failureResult(failure);
    const result = this.apply();
    return failure ? failureResult(failure) : result;
  }

  private apply(): { data: unknown; error: unknown; status: number } {
    const rows = this.server.tables[this.table] ?? [];
    this.server.tables[this.table] = rows;
    let out: Row[] = [];

    if (this.op === "select") {
      out = rows.filter((r) => this.matches(r));
    } else if (this.op === "insert" || this.op === "upsert") {
      const incoming = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
      const keys = (this.options.onConflict ?? "id").split(",").map((k) => k.trim());
      for (const row of incoming) {
        // The planning migration's BEFORE INSERT trigger looks the plan up first, and runs even
        // when ON CONFLICT is about to skip the row.
        if (
          this.table === "meal_plan_entries" &&
          !(this.server.tables.meal_plans ?? []).some((plan) => plan.id === row.plan_id)
        ) {
          return {
            data: null,
            error: { message: "plan_not_found", code: "P0001", details: "", hint: "" },
            status: 400,
          };
        }
        const existing = rows.find((r) => keys.every((k) => r[k] === row[k]));
        if (existing) {
          if (this.op === "insert") {
            return {
              data: null,
              error: { message: "duplicate key value", code: "23505", details: "", hint: "" },
              status: 409,
            };
          }
          if (!this.options.ignoreDuplicates) {
            Object.assign(existing, row);
            out.push(existing);
          }
          continue;
        }
        const created: Row = {
          ...(DEFAULTS[this.table]?.() ?? {}),
          ...row,
          ...(row.id === undefined ? { id: `generated-${rows.length + 1}` } : {}),
          created_at: this.server.now(),
          updated_at: this.server.now(),
        };
        rows.push(created);
        out.push(created);
      }
    } else if (this.op === "update") {
      for (const row of rows.filter((r) => this.matches(r))) {
        Object.assign(row, this.payload as Row, { updated_at: this.server.now() });
        out.push(row);
      }
    } else {
      const doomed = rows.filter((r) => this.matches(r));
      this.server.tables[this.table] = rows.filter((r) => !doomed.includes(r));
      out = doomed;
    }

    for (const [column, ascending] of [...this.orders].reverse()) {
      out = [...out].sort((a, b) => {
        const x = String(a[column] ?? "");
        const y = String(b[column] ?? "");
        return ascending ? x.localeCompare(y) : y.localeCompare(x);
      });
    }
    if (this.max !== undefined) out = out.slice(0, this.max);
    const shaped = out.map((row) => this.withEmbeds(row));

    const status = this.op === "insert" || this.op === "upsert" ? 201 : 200;
    if (this.shape !== "many") {
      const first = shaped[0] ?? null;
      if (this.shape === "one" && !first) {
        return {
          data: null,
          error: {
            message: "JSON object requested, multiple (or no) rows returned",
            code: "PGRST116",
          },
          status: 406,
        };
      }
      return { data: first, error: null, status };
    }
    const returnsRows = this.op === "select" || this.returning;
    return { data: returnsRows ? shaped : null, error: null, status };
  }

  // biome-ignore lint/suspicious/noThenProperty: a thenable stands in for the PostgREST builder.
  then<R1 = unknown, R2 = never>(
    onfulfilled?: ((value: unknown) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return Promise.resolve()
      .then(() => this.server.gate)
      .then(() => this.run())
      .then(onfulfilled, onrejected);
  }
}

function failureResult(failure: Failure) {
  return {
    data: null,
    error: { message: failure.message, code: failure.code ?? "", details: "", hint: "" },
    status: failure.status,
  };
}

/** Channels recorded for the Realtime tests. */
export interface FakeChannel {
  name: string;
  handlers: Array<{
    type: string;
    filter: { event: string; schema: string; table: string; filter?: string };
    callback: (payload: unknown) => void;
  }>;
  statusCallback?: (status: string) => void;
  removed: boolean;
  on: (
    type: string,
    filter: FakeChannel["handlers"][number]["filter"],
    cb: (p: unknown) => void,
  ) => FakeChannel;
  subscribe: (cb?: (status: string) => void) => FakeChannel;
}

export function fakeClient(server: FakeServer = new FakeServer()) {
  const channels: FakeChannel[] = [];
  const client = {
    from: (table: string) => new Query(server, table),
    channel: (name: string) => {
      const channel: FakeChannel = {
        name,
        handlers: [],
        removed: false,
        on(type, filter, callback) {
          channel.handlers.push({ type, filter, callback });
          return channel;
        },
        subscribe(callback) {
          channel.statusCallback = callback;
          return channel;
        },
      };
      channels.push(channel);
      return channel;
    },
    removeChannel: (channel: FakeChannel) => {
      channel.removed = true;
      return Promise.resolve("ok");
    },
  };
  return { client: client as unknown as MpClient, server, channels };
}
