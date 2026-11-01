// A stand-in for the slice of supabase-js the order and History readers use, for unit tests. It
// answers each request with the next canned response and records what was asked, so a test can
// check the filters, the order, the limit and the arguments a reader sent. It is not a database:
// the pgTAP file (supabase/tests/ws12_orders_rls.sql) covers the policies, the function and the
// views. Unlike fakeClient.ts it understands rpc, gt/gte/lt, and views, and it keeps no rows.
import type { MpClient } from "../client";

export interface CannedResponse {
  data?: unknown;
  error?: { message: string; code?: string } | null;
  status?: number;
}

export type RecordedOp = [method: string, ...args: unknown[]];

export interface RecordedCall {
  /** The table or view for `from`, the function name for `rpc`. */
  target: string;
  kind: "from" | "rpc";
  ops: RecordedOp[];
  /** The arguments passed to `rpc`. */
  args?: unknown;
}

export function recordingClient(responses: CannedResponse[]) {
  const queue = [...responses];
  const calls: RecordedCall[] = [];

  const builder = (call: RecordedCall): unknown => {
    const proxy: unknown = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "then") {
            return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
              const next = queue.shift() ?? { data: null, error: null, status: 200 };
              return Promise.resolve({
                data: next.data ?? null,
                error: next.error ?? null,
                status: next.status ?? (next.error ? 400 : 200),
              }).then(resolve, reject);
            };
          }
          return (...args: unknown[]) => {
            call.ops.push([String(prop), ...args]);
            return proxy;
          };
        },
      },
    );
    return proxy;
  };

  const client = {
    from: (table: string) => {
      const call: RecordedCall = { target: table, kind: "from", ops: [] };
      calls.push(call);
      return builder(call);
    },
    rpc: (fn: string, args?: unknown) => {
      const call: RecordedCall = { target: fn, kind: "rpc", ops: [], args };
      calls.push(call);
      return builder(call);
    },
  };
  return { client: client as unknown as MpClient, calls, remaining: () => queue.length };
}

/** The arguments of the first op with this name, or undefined. */
export function opArgs(call: RecordedCall | undefined, method: string): unknown[] | undefined {
  return call?.ops.find(([name]) => name === method)?.slice(1);
}

/** Every `eq` filter of a call as [column, value] pairs. */
export function eqFilters(call: RecordedCall | undefined): Array<[unknown, unknown]> {
  return (call?.ops ?? [])
    .filter(([name]) => name === "eq")
    .map(([, column, value]) => [column, value]);
}
