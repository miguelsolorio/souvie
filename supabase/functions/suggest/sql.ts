// Adapts a Postgres driver to the SqlRunner the suggest function is written against. The driver is
// postgres.js (client.ts); this file only needs the two calls below, so it has no imports and a
// test can drive it with a fake.
import type { SqlRunner } from "./candidates.ts";

/** The slice of a postgres.js client this function uses. */
export interface PgClient {
  /** Runs one statement with `$1`-style parameters and resolves to its rows. */
  unsafe(text: string, params?: unknown[]): PromiseLike<unknown[]>;
  /** Runs `fn` in a transaction: commit when it resolves, roll back when it throws. */
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
