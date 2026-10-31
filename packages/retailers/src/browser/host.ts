// BrowserHost: the one surface every Tier 3 browser adapter (WS10) drives. docs/04-integrations.md
// §Tier 3. A host is a real browser the user owns and watches: the app's WebView on the phone
// (Mode A, apps/mobile/src/features/tier3/WebViewHost.tsx), later the desktop app's webview window
// (WS13). A cloud headless host (Mode C) is forbidden and must never implement this interface.
//
// Platform-neutral on purpose: no React Native, DOM, Node or Deno imports here, so the same adapters
// run on any host.
import type { SnapshotTree } from "./snapshot.ts";

/**
 * Why the host stopped and handed the page to the person. The bridge raises these; WS10 decides
 * what to do. `pay` and `membership` are WS10 pause reasons raised by site recipes, never by the
 * host.
 *   login        a sign-in URL or a password field is on screen
 *   captcha      a node or iframe named like a human check (captcha, "verify you are human",
 *                "press and hold")
 *   mfa          a one-time-code field (autocomplete="one-time-code" and the usual names)
 *   unexpected   the page left the retailer's own domains, or the host lost the bridge
 */
export type UserRequiredReason = "captcha" | "mfa" | "login" | "unexpected";

export const USER_REQUIRED_REASONS: readonly UserRequiredReason[] = [
  "login",
  "captcha",
  "mfa",
  "unexpected",
];

export interface SnapshotOptions {
  /** Upper bound on nodes in the tree. The tree says `truncated: true` when it hit the cap. */
  maxNodes?: number;
}

export interface TypeOptions {
  /** Empty the field first. */
  clear?: boolean;
}

export interface BrowserHost {
  /** Loads a URL and resolves once the bridge reports ready on the new document. */
  navigate(url: string): Promise<void>;
  /** The current document URL. */
  url(): Promise<string>;
  /** The page as a tree with ids that stay the same across calls on an unchanged DOM. */
  snapshot(opts?: SnapshotOptions): Promise<SnapshotTree>;
  /** A real click (pointer and mouse events, then the element's click). */
  click(nodeId: string): Promise<void>;
  /** Types like a person: focus, key and input events per character, then change. */
  type(nodeId: string, text: string, opts?: TypeOptions): Promise<void>;
  /** Picks an option of a select (by value or by visible text), or clicks an option node. */
  select(nodeId: string, value: string): Promise<void>;
  /**
   * Resolves when `check` returns true for a snapshot the bridge streams (every 250 ms), or
   * rejects with `BrowserHostError("timeout")`. Keep `check` cheap: it runs on every snapshot.
   */
  waitFor(check: (tree: SnapshotTree, url: string) => boolean, timeoutMs: number): Promise<void>;
  /** A JPEG of what the person sees, taken by the host, never by page script. */
  screenshot(): Promise<Uint8Array>;
  /** Called every time the page needs the person. Several callbacks may be registered. */
  onUserRequired(cb: (reason: UserRequiredReason) => void): void;
}

export type BrowserHostErrorCode =
  /** waitFor, or a bridge reply, did not arrive in time. */
  | "timeout"
  /** The node id is not on the page any more. Take a new snapshot. */
  | "stale_node"
  /** The node cannot take this action (typing into a button, selecting on a link). */
  | "not_actionable"
  /** Typing into a password field is refused: passwords are typed by the person, never by us. */
  | "password_field"
  /** The option to select does not exist. */
  | "no_such_option"
  /** The page did not load or left the allowed domains. */
  | "navigation_failed"
  /** The bridge is not on the page (it is re-injected on every load). */
  | "bridge_unavailable"
  /** Screenshot capture failed. */
  | "capture_failed"
  /** The host was closed while a call was waiting. */
  | "closed";

export class BrowserHostError extends Error {
  readonly code: BrowserHostErrorCode;

  constructor(code: BrowserHostErrorCode, message?: string, options?: ErrorOptions) {
    super(message ?? code, options);
    this.name = "BrowserHostError";
    this.code = code;
  }
}

export function isBrowserHostError(value: unknown): value is BrowserHostError {
  return value instanceof BrowserHostError;
}
