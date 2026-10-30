// Test helper: a fetch that answers from recorded responses and logs every request. No network.
import type { Product, Store } from "../../types.ts";
import { InMemoryQuotaStore } from "../quota.ts";

export interface RecordedResponse {
  request?: { method: string; path: string };
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface SeenRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: string | null;
}

export type Responder = RecordedResponse | ((req: SeenRequest) => RecordedResponse);

export interface Route {
  method?: string;
  /** Pathname to match, for example "/v1/products". */
  path: string;
  respond: Responder | Responder[];
}

export function toResponse(rec: RecordedResponse): Response {
  const noBody = rec.status === 204 || rec.status === 304 || rec.body === null;
  return new Response(noBody ? null : JSON.stringify(rec.body), {
    status: rec.status,
    headers: rec.headers,
  });
}

/**
 * Routes match on method and pathname. A route with an array of responders answers them in turn
 * and repeats the last one.
 */
export function replay(routes: Route[]): { fetch: typeof fetch; requests: SeenRequest[] } {
  const requests: SeenRequest[] = [];
  const counters = new Map<Route, number>();
  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input : input.url,
    );
    const method = (init?.method ?? "GET").toUpperCase();
    const seen: SeenRequest = {
      method,
      url,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : null,
    };
    requests.push(seen);
    const route = routes.find(
      (r) => (r.method ?? "GET").toUpperCase() === method && r.path === url.pathname,
    );
    if (!route) throw new Error(`replay: no route for ${method} ${url.pathname}`);
    const list = Array.isArray(route.respond) ? route.respond : [route.respond];
    const n = counters.get(route) ?? 0;
    counters.set(route, n + 1);
    const responder = list[Math.min(n, list.length - 1)] as Responder;
    return toResponse(typeof responder === "function" ? responder(seen) : responder);
  };
  return { fetch: fake as typeof fetch, requests };
}

/** Requests to one pathname, in order. */
export function to(requests: SeenRequest[], path: string, method = "GET"): SeenRequest[] {
  return requests.filter((r) => r.url.pathname === path && r.method === method);
}

export const QFC_STORE: Store = {
  id: "70500999",
  retailer: "kroger",
  chain: "QFC",
  name: "Quality Food Center - Fixture Ridge",
  address: "100 Fixture Ridge Rd NE, Duvall, WA",
  zip: "98019",
  lat: 47.7401,
  lng: -121.9862,
};

/** Fixed clock: 2026-10-30T19:28:41Z, the fixtures' Date header. */
export const T0 = Date.parse("2026-10-30T19:28:41Z");

export function clock(start = T0) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
    set(ms: number) {
      now = ms;
    },
  };
}

export const TEST_CONFIG = {
  clientId: "fixture-client-id",
  clientSecret: "fixture-client-secret",
  redirectUri: "souvie://oauth/kroger",
};

export function freshQuota(): InMemoryQuotaStore {
  return new InMemoryQuotaStore();
}

export function names(products: Product[]): string[] {
  return products.map((p) => p.name);
}
