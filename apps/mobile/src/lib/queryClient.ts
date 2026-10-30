import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import { type Query, QueryClient } from "@tanstack/react-query";
import type { PersistQueryClientProviderProps } from "@tanstack/react-query-persist-client";
import { kvStorage } from "./storage";

declare module "@tanstack/react-query" {
  interface Register {
    queryMeta: {
      /** Opt this query into the on-device cache. Off by default. */
      persist?: boolean;
    };
  }
}

/** Bump to drop every persisted cache after a breaking change to cached shapes. */
export const QUERY_CACHE_BUSTER = "v1";
export const QUERY_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// The static web export renders in Node. A finite gcTime there leaves a 24 hour timer that
// keeps the export process alive, so the server keeps TanStack Query's default (no GC).
const isServer = typeof window === "undefined";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60 * 1000,
      // Must be at least maxAge, or restored queries are garbage-collected right away.
      gcTime: isServer ? Number.POSITIVE_INFINITY : QUERY_CACHE_MAX_AGE_MS,
      retry: 2,
    },
  },
});

/**
 * Only successful queries that set `meta: { persist: true }` reach device storage.
 * Retailer terms forbid storing search-derived data and caching catalog data past its
 * cache headers (docs/04-integrations.md), so persistence is opt-in per query.
 */
export function shouldPersistQuery(query: Pick<Query, "state" | "meta">): boolean {
  return query.state.status === "success" && query.meta?.persist === true;
}

export const queryPersister = createSyncStoragePersister({
  storage: kvStorage,
  key: "mp-query-cache",
  throttleTime: 1000,
});

export const persistOptions: PersistQueryClientProviderProps["persistOptions"] = {
  persister: queryPersister,
  maxAge: QUERY_CACHE_MAX_AGE_MS,
  buster: QUERY_CACHE_BUSTER,
  dehydrateOptions: { shouldDehydrateQuery: shouldPersistQuery },
};
