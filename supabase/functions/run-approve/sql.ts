// What run-approve needs from a database, and the adapter that backs it with a Postgres driver.
// Same shape as list-build's (../list-build/sql.ts): this file has no imports, so a test drives the
// store with PGlite instead of postgres.js.

/** Run SQL with parameters and get rows back, and run several statements as one transaction. */
export interface SqlRunner {
  query<T = Record<string, unknown>>(text: string, params: readonly unknown[]): Promise<T[]>;
  /** Runs `fn` in one transaction: it commits when `fn` returns and rolls back when it throws. */
  transaction<T>(fn: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

/** The slice of a postgres.js client this function uses. */
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
