// Error reports from Edge Functions to Sentry (WS15). The choice: a plain `fetch` to Sentry's
// envelope endpoint, not the Deno SDK. A function reports only the failures it already turns into a
// 500, so it needs one POST, not breadcrumbs, tracing or auto-instrumentation; the SDK would add an
// npm import map entry to every function's deno.json and cold-start weight to all of them; and one
// small file means one scrubber (scrub.ts) stands in front of everything that leaves.
//
// Without SENTRY_DSN nothing is sent. The report never throws and never delays the response: on
// the Supabase Edge runtime it is handed to `EdgeRuntime.waitUntil`, elsewhere it is fire and
// forget. What an event carries: the function's name, the release (SENTRY_RELEASE or GIT_SHA), the
// environment, a `household_id` tag when the caller knows one, and the error's type, message
// (scrubbed) and stack frames. No user, no request, no headers, no body.
import { scrubEvent } from "./scrub.ts";

export interface ErrorContext {
  /** The function's name: suggest, recipe-import, parse-ingredients, llm-proxy. */
  function: string;
  householdId?: string | null | undefined;
}

export interface EdgeReporter {
  readonly enabled: boolean;
  /** Fire and forget; never throws. */
  captureException(error: unknown, context: ErrorContext): void;
}

export interface Dsn {
  publicKey: string;
  host: string;
  projectId: string;
  protocol: string;
}

/** https://<public key>@<host>/<project id>, or null when it is not one. */
export function parseDsn(dsn: string | undefined): Dsn | null {
  const text = dsn?.trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    const projectId =
      url.pathname
        .replace(/^\/+|\/+$/g, "")
        .split("/")
        .pop() ?? "";
    if (!url.username || !/^\d+$/.test(projectId)) return null;
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return {
      publicKey: decodeURIComponent(url.username),
      host: url.host,
      projectId,
      protocol: url.protocol.replace(":", ""),
    };
  } catch {
    return null;
  }
}

export interface Frame {
  filename: string;
  function: string;
  lineno?: number;
  colno?: number;
  in_app: boolean;
}

/** V8 stack lines: "    at fn (file:///src/x.ts:10:5)" or "    at file:///src/x.ts:10:5". */
export function parseStack(stack: string | undefined): Frame[] {
  if (!stack) return [];
  const frames: Frame[] = [];
  for (const line of stack.split("\n")) {
    const match = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/.exec(line);
    if (!match?.[2]) continue;
    const filename = match[2];
    frames.push({
      filename,
      function: match[1] ?? "<anonymous>",
      lineno: Number(match[3]),
      colno: Number(match[4]),
      in_app: !filename.includes("/node_modules/") && !filename.startsWith("ext:"),
    });
  }
  // Sentry wants the oldest call first.
  return frames.reverse();
}

export interface EdgeReporterOptions {
  dsn?: string | undefined;
  release?: string | undefined;
  environment?: string | undefined;
  fetch?: typeof fetch;
  /** Keeps the invocation alive for the POST; `EdgeRuntime.waitUntil` on Supabase. */
  waitUntil?: ((promise: Promise<unknown>) => void) | undefined;
  now?: () => Date;
  newId?: () => string;
}

const NOOP: EdgeReporter = { enabled: false, captureException() {} };

export function createEdgeReporter(options: EdgeReporterOptions): EdgeReporter {
  const dsn = parseDsn(options.dsn);
  if (!dsn) return NOOP;
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => crypto.randomUUID().replaceAll("-", ""));
  const release = options.release?.trim();

  return {
    enabled: true,
    captureException(error, context) {
      try {
        const err = error instanceof Error ? error : new Error(String(error));
        const at = now();
        const eventId = newId();
        const tags: Record<string, string> = { function: context.function, runtime: "edge" };
        if (context.householdId) tags.household_id = context.householdId;
        const event = scrubEvent({
          event_id: eventId,
          timestamp: at.getTime() / 1000,
          platform: "javascript",
          level: "error",
          logger: "edge-function",
          ...(release ? { release } : {}),
          environment: options.environment?.trim() || "production",
          tags,
          exception: {
            values: [
              {
                type: err.name || "Error",
                value: err.message,
                stacktrace: { frames: parseStack(err.stack) },
              },
            ],
          },
        });
        const envelope = [
          JSON.stringify({ event_id: eventId, sent_at: at.toISOString() }),
          JSON.stringify({ type: "event" }),
          JSON.stringify(event),
        ].join("\n");
        const url = `${dsn.protocol}://${dsn.host}/api/${dsn.projectId}/envelope/`;
        const sent = doFetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-sentry-envelope",
            "X-Sentry-Auth": `Sentry sentry_version=7, sentry_client=souvie-edge/1, sentry_key=${dsn.publicKey}`,
          },
          body: envelope,
        }).then(
          () => undefined,
          () => undefined,
        );
        options.waitUntil?.(sent);
      } catch {
        // Reporting never breaks a response.
      }
    },
  };
}

interface DenoLike {
  env: { get(name: string): string | undefined };
}

let cached: EdgeReporter | undefined;

/** The reporter for this isolate, from the function's secrets: SENTRY_DSN and friends. */
export function edgeReporter(): EdgeReporter {
  if (cached) return cached;
  const g = globalThis as {
    Deno?: DenoLike;
    EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void };
  };
  let get: (name: string) => string | undefined;
  try {
    const env = g.Deno?.env;
    get = (name) => env?.get(name);
    get("SENTRY_DSN");
  } catch {
    // Reading the environment can be denied; then there is no DSN.
    get = () => undefined;
  }
  const runtime = g.EdgeRuntime;
  cached = createEdgeReporter({
    dsn: get("SENTRY_DSN"),
    release: get("SENTRY_RELEASE") ?? get("GIT_SHA"),
    environment: get("SENTRY_ENVIRONMENT"),
    waitUntil: runtime ? (promise) => runtime.waitUntil(promise) : undefined,
  });
  return cached;
}

/** Tests replace the isolate's reporter. */
export function setEdgeReporterForTests(next: EdgeReporter | undefined): void {
  cached = next;
}

/** Reports an error from a handler's catch block. One line at the call site. */
export function reportError(error: unknown, context: ErrorContext): void {
  edgeReporter().captureException(error, context);
}
