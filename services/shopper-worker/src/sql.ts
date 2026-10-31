// What the worker needs from a database, and the adapter that backs it with postgres.js. The same
// shape as list-build's (supabase/functions/list-build/sql.ts), so the store tests drive it with
// PGlite instead.

export interface SqlRunner {
  query<T = Record<string, unknown>>(text: string, params: readonly unknown[]): Promise<T[]>;
  /** Runs `fn` in one transaction: it commits when `fn` returns and rolls back when it throws. */
  transaction<T>(fn: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

/** The slice of a postgres.js client this worker uses. */
export interface PgClient {
  unsafe(text: string, params?: unknown[]): PromiseLike<unknown[]>;
  begin<T>(fn: (tx: PgClient) => Promise<T>): Promise<T>;
}

export function runnerOf(pg: PgClient): SqlRunner {
  return {
    async query<T>(text: string, params: readonly unknown[]): Promise<T[]> {
      return (await pg.unsafe(text, [...params])) as T[];
    },
    transaction<T>(fn: (tx: SqlRunner) => Promise<T>): Promise<T> {
      return pg.begin((tx) => fn(runnerOf(tx)));
    },
  };
}
