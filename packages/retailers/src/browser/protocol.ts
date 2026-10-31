// The bridge message protocol (WS08), host <-> injected page script. docs/04-integrations.md
// §Tier 3 has the table. Platform-neutral: the WebView host on the phone and a desktop webview host
// (WS13) speak the same messages to the same bridge.js.
//
// Every page -> host message carries the envelope marker and the per-injection token, so a message
// the retailer's own scripts post through the same channel is ignored. The token lives in the
// bridge's closure, not on `window`.
import type { UserRequiredReason } from "./host.ts";
import type { SnapshotTree } from "./snapshot.ts";

export const BRIDGE_ENVELOPE = "mp-tier3-bridge";
export const BRIDGE_PROTOCOL_VERSION = 1;
/** waitFor streams a snapshot this often. */
export const WAIT_INTERVAL_MS = 250;

// ---------------------------------------------------------------------------------------
// host -> page
// ---------------------------------------------------------------------------------------

export type HostMessage =
  | { type: "snapshot"; requestId: string; maxNodes: number }
  | { type: "click"; requestId: string; nodeId: string }
  | { type: "type"; requestId: string; nodeId: string; text: string; clear?: boolean }
  | { type: "select"; requestId: string; nodeId: string; value: string }
  | { type: "waitFor"; requestId: string; timeoutMs: number; maxNodes: number }
  | { type: "waitFor.stop"; requestId: string }
  /** Session handling (useTier3Session): this origin's localStorage and sessionStorage. */
  | { type: "storage.read"; requestId: string };

// `navigate` is not a page message: the host changes the WebView's source and the bridge is
// injected again on the new document, which then sends `ready`.

// ---------------------------------------------------------------------------------------
// page -> host
// ---------------------------------------------------------------------------------------

export interface BridgeErrorPayload {
  code: string;
  message: string;
}

export type PageMessage =
  /** The bridge is installed on a document and can take messages. */
  | { type: "ready"; url: string; title: string }
  | { type: "snapshot.result"; requestId: string; tree: SnapshotTree }
  | { type: "action.result"; requestId: string; ok: boolean; error?: BridgeErrorPayload }
  | { type: "userRequired"; reason: UserRequiredReason; nodeId?: string; url: string }
  | { type: "navigated"; url: string; title: string }
  | {
      type: "storage.result";
      requestId: string;
      origin: string;
      localStorage: Record<string, string>;
      sessionStorage: Record<string, string>;
    };

const REASONS = new Set<string>(["login", "captcha", "mfa", "unexpected"]);

function isRecordOfStrings(value: unknown): value is Record<string, string> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === "string")
  );
}

/**
 * Reads one raw message from the page. Returns null for anything that is not ours: wrong envelope,
 * wrong token, unknown type, or a malformed payload. Never throws.
 */
export function parsePageMessage(raw: unknown, token: string): PageMessage | null {
  let data: unknown = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== "object") return null;
  const m = data as Record<string, unknown>;
  if (m.__mp !== BRIDGE_ENVELOPE || m.token !== token || m.v !== BRIDGE_PROTOCOL_VERSION) {
    return null;
  }
  const str = (k: string) => typeof m[k] === "string";
  switch (m.type) {
    case "ready":
    case "navigated":
      return str("url") && str("title")
        ? { type: m.type, url: m.url as string, title: m.title as string }
        : null;
    case "snapshot.result": {
      const tree = m.tree as SnapshotTree | undefined;
      if (!str("requestId") || !tree || typeof tree !== "object" || !tree.root) return null;
      return { type: "snapshot.result", requestId: m.requestId as string, tree };
    }
    case "action.result": {
      if (!str("requestId") || typeof m.ok !== "boolean") return null;
      const err = m.error as BridgeErrorPayload | undefined;
      const error =
        err && typeof err.code === "string" && typeof err.message === "string"
          ? { code: err.code, message: err.message }
          : undefined;
      return {
        type: "action.result",
        requestId: m.requestId as string,
        ok: m.ok,
        ...(error ? { error } : {}),
      };
    }
    case "userRequired": {
      if (typeof m.reason !== "string" || !REASONS.has(m.reason) || !str("url")) return null;
      return {
        type: "userRequired",
        reason: m.reason as UserRequiredReason,
        url: m.url as string,
        ...(str("nodeId") ? { nodeId: m.nodeId as string } : {}),
      };
    }
    case "storage.result": {
      if (!str("requestId") || !str("origin")) return null;
      if (!isRecordOfStrings(m.localStorage) || !isRecordOfStrings(m.sessionStorage)) return null;
      return {
        type: "storage.result",
        requestId: m.requestId as string,
        origin: m.origin as string,
        localStorage: m.localStorage,
        sessionStorage: m.sessionStorage,
      };
    }
    default:
      return null;
  }
}

/** The JavaScript the host evaluates in the page to deliver one message to the bridge. */
export function hostMessageScript(token: string, message: HostMessage): string {
  // JSON.stringify output is a valid JS expression; the second stringify makes it a string
  // literal the bridge parses, so nothing in the payload is evaluated as code.
  const payload = JSON.stringify(JSON.stringify(message));
  const name = JSON.stringify(bridgeGlobalName(token));
  return `(function(){var b=window[${name}];if(b){b.receive(${payload});}})();true;`;
}

/** Where the bridge installs its receiver. Keyed by the token so page code cannot guess it. */
export function bridgeGlobalName(token: string): string {
  return `__mpTier3Bridge_${token}`;
}
