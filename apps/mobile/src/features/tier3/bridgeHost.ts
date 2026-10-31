// The host side of the bridge protocol (WS08): a BrowserHost over any page transport. WebViewHost
// wires it to react-native-webview; the bridge tests wire it to jsdom over the bundled test page.
// No React Native import here, so it runs in Vitest as is.
//
// Lifecycle of one document:
//   load(url)        the WebView's source changes; the bridge is injected before content loads
//   notifyLoadStart  a new document begins; calls in flight on the old one fail (bridge_unavailable)
//   "ready"          the bridge is installed; queued calls go out; navigate() resolves
//   notifyLoadEnd    the host injects the bridge again (SPA-safe; the bridge ignores a second copy)
import {
  type BrowserHost,
  BrowserHostError,
  type BrowserHostErrorCode,
  DEFAULT_MAX_NODES,
  type HostMessage,
  hostMessageScript,
  type PageMessage,
  parsePageMessage,
  type SnapshotTree,
  type UserRequiredReason,
  WAIT_MAX_NODES,
} from "@mp/retailers";
import { buildBridgeScript } from "./bridgeScript";

export interface BridgeTransport {
  /** Runs JavaScript in the page (react-native-webview `injectJavaScript`). */
  evaluate(script: string): void;
  /** Points the page at a new URL (the WebView's `source`). */
  load(url: string): void;
  /** A JPEG of what the person sees. */
  capture(): Promise<Uint8Array>;
}

export interface BridgeHostOptions {
  /** Signs every page message; stays in the bridge's closure. */
  token: string;
  /** The bridge's global the host calls (newBridgeReceiver). Random, never the token. */
  receiver: string;
  /** Replies slower than this fail with `timeout`. Default 10 s. */
  requestTimeoutMs?: number;
  /** navigate() fails when the bridge has not reported ready by then. Default 30 s. */
  navigateTimeoutMs?: number;
  /** Cap on the snapshots streamed during waitFor. */
  waitMaxNodes?: number;
  /**
   * Hosts the page may be on (exact, or a subdomain of one). Leaving them raises
   * onUserRequired("unexpected"). Unset means any host (the dev snapshot tool).
   */
  allowedHosts?: readonly string[];
}

export interface StorageDump {
  origin: string;
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
}

export interface BridgeHost extends BrowserHost {
  /** The script to inject before content loads and again on every load end. */
  readonly bridgeScript: string;
  /** Feed every WebView message here (onMessage's `nativeEvent.data`). */
  receive(raw: string): void;
  notifyLoadStart(url: string): void;
  notifyLoadEnd(url: string): void;
  /** Every URL change the WebView reports (onNavigationStateChange). */
  notifyNavigation(url: string): void;
  /** This origin's localStorage and sessionStorage, for saving a session. */
  readStorage(): Promise<StorageDump>;
  /** Empties this origin's storage once the session is saved, so none of it stays in plaintext. */
  clearPageStorage(): void;
  /** True between the bridge's `ready` and the next load start. */
  isReady(): boolean;
  close(): void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  /** The document epoch the request was sent in, null while it waits in the queue. */
  epoch: number | null;
  message: HostMessage;
}

interface Waiting {
  check: (tree: SnapshotTree, url: string) => boolean;
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  deadline: number;
}

export function hostAllowed(url: string, allowed: readonly string[] | undefined): boolean {
  if (!allowed) return true;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (url.startsWith("about:")) return true;
  return allowed.some((a) => {
    const d = a.toLowerCase().replace(/^\./, "");
    return host === d || host.endsWith(`.${d}`);
  });
}

export function createBridgeHost(
  transport: BridgeTransport,
  options: BridgeHostOptions,
): BridgeHost {
  const token = options.token;
  const receiver = options.receiver;
  const bridgeScript = buildBridgeScript(token, receiver);
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const navigateTimeoutMs = options.navigateTimeoutMs ?? 30_000;
  const waitMaxNodes = options.waitMaxNodes ?? WAIT_MAX_NODES;

  let ready = false;
  let closed = false;
  let epoch = 0;
  let currentUrl = "about:blank";
  let counter = 0;
  const pending = new Map<string, Pending>();
  const queue: string[] = [];
  const waits = new Map<string, Waiting>();
  const listeners = new Set<(reason: UserRequiredReason) => void>();
  let navigation: {
    resolve(): void;
    reject(e: Error): void;
    timer: ReturnType<typeof setTimeout>;
    /** The epoch when navigate() was called: only a ready from a later document settles it. */
    epoch: number;
  } | null = null;

  const nextId = () => `r${++counter}`;

  function fail(code: BrowserHostErrorCode, message?: string): BrowserHostError {
    return new BrowserHostError(code, message);
  }

  function emit(reason: UserRequiredReason) {
    for (const cb of listeners) {
      try {
        cb(reason);
      } catch (err) {
        console.warn("onUserRequired callback threw", err);
      }
    }
  }

  function deliver(message: HostMessage) {
    transport.evaluate(hostMessageScript(receiver, message));
  }

  function send(message: HostMessage) {
    if (closed) return;
    if (!ready) {
      queue.push(message.requestId);
      return;
    }
    const p = pending.get(message.requestId);
    if (p) p.epoch = epoch;
    deliver(message);
  }

  function request<T>(message: HostMessage, timeoutMs = requestTimeoutMs): Promise<T> {
    if (closed) return Promise.reject(fail("closed"));
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(message.requestId);
        reject(fail("timeout", `No reply to ${message.type} within ${timeoutMs} ms`));
      }, timeoutMs);
      pending.set(message.requestId, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        epoch: null,
        message,
      });
      send(message);
    });
  }

  function settle(requestId: string, outcome: { value?: unknown; error?: Error }) {
    const p = pending.get(requestId);
    if (!p) return;
    pending.delete(requestId);
    clearTimeout(p.timer);
    if (outcome.error) p.reject(outcome.error);
    else p.resolve(outcome.value);
  }

  function flushQueue() {
    while (ready && queue.length > 0) {
      const id = queue.shift() as string;
      const p = pending.get(id);
      if (p) {
        p.epoch = epoch;
        deliver(p.message);
      }
    }
    // A wait outlives a navigation: start it again on the new document.
    for (const [requestId, w] of waits) {
      const left = Math.max(0, w.deadline - Date.now());
      deliver({ type: "waitFor", requestId, timeoutMs: left, maxNodes: waitMaxNodes });
    }
  }

  function onMessage(message: PageMessage) {
    switch (message.type) {
      case "ready":
        currentUrl = message.url;
        if (!hostAllowed(message.url, options.allowedHosts)) emit("unexpected");
        ready = true;
        if (navigation && epoch > navigation.epoch) {
          clearTimeout(navigation.timer);
          navigation.resolve();
          navigation = null;
        }
        flushQueue();
        return;
      case "navigated":
        currentUrl = message.url;
        if (!hostAllowed(message.url, options.allowedHosts)) emit("unexpected");
        return;
      case "userRequired":
        emit(message.reason);
        return;
      case "snapshot.result": {
        const w = waits.get(message.requestId);
        if (w) {
          let done = false;
          try {
            done = w.check(message.tree, message.tree.url);
          } catch (err) {
            stopWait(message.requestId);
            w.reject(err instanceof Error ? err : new Error(String(err)));
            return;
          }
          if (done) {
            stopWait(message.requestId);
            w.resolve();
          }
          return;
        }
        settle(message.requestId, { value: message.tree });
        return;
      }
      case "action.result":
        if (message.ok) settle(message.requestId, { value: undefined });
        else {
          const code = (message.error?.code ?? "action_failed") as BrowserHostErrorCode;
          settle(message.requestId, { error: fail(code, message.error?.message) });
        }
        return;
      case "storage.result":
        settle(message.requestId, {
          value: {
            origin: message.origin,
            localStorage: message.localStorage,
            sessionStorage: message.sessionStorage,
          } satisfies StorageDump,
        });
        return;
    }
  }

  function stopWait(requestId: string) {
    const w = waits.get(requestId);
    if (!w) return;
    clearTimeout(w.timer);
    waits.delete(requestId);
    if (ready) deliver({ type: "waitFor.stop", requestId });
  }

  const host: BridgeHost = {
    bridgeScript,

    receive(raw) {
      const message = parsePageMessage(raw, token);
      if (message) onMessage(message);
    },

    notifyLoadStart(url) {
      epoch += 1;
      ready = false;
      currentUrl = url;
      // Calls already sent to the old document will never be answered.
      for (const [id, p] of pending) {
        if (p.epoch !== null && p.epoch < epoch) {
          pending.delete(id);
          clearTimeout(p.timer);
          p.reject(fail("bridge_unavailable", "The page changed before it answered"));
        }
      }
    },

    notifyLoadEnd(url) {
      currentUrl = url;
      transport.evaluate(bridgeScript);
    },

    notifyNavigation(url) {
      currentUrl = url;
      if (!hostAllowed(url, options.allowedHosts)) emit("unexpected");
    },

    isReady: () => ready,

    async navigate(url) {
      if (closed) throw fail("closed");
      if (!/^https?:\/\//i.test(url))
        throw fail("navigation_failed", "Only http(s) pages can open");
      if (!hostAllowed(url, options.allowedHosts)) {
        throw fail("navigation_failed", "That page is not on this store's own site");
      }
      if (navigation) {
        clearTimeout(navigation.timer);
        navigation.reject(fail("navigation_failed", "Replaced by a newer navigation"));
      }
      const done = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          navigation = null;
          reject(fail("timeout", `The page did not load within ${navigateTimeoutMs} ms`));
        }, navigateTimeoutMs);
        navigation = { resolve, reject, timer, epoch };
      });
      ready = false;
      transport.load(url);
      return done;
    },

    async url() {
      return currentUrl;
    },

    snapshot(opts) {
      const maxNodes = Math.max(1, Math.floor(opts?.maxNodes ?? DEFAULT_MAX_NODES));
      return request<SnapshotTree>({ type: "snapshot", requestId: nextId(), maxNodes });
    },

    click(nodeId) {
      return request<void>({ type: "click", requestId: nextId(), nodeId });
    },

    type(nodeId, text, opts) {
      return request<void>(
        {
          type: "type",
          requestId: nextId(),
          nodeId,
          text,
          ...(opts?.clear ? { clear: true } : {}),
        },
        // A long text fires a few events per character.
        requestTimeoutMs + text.length * 20,
      );
    },

    select(nodeId, value) {
      return request<void>({ type: "select", requestId: nextId(), nodeId, value });
    },

    waitFor(check, timeoutMs) {
      if (closed) return Promise.reject(fail("closed"));
      const requestId = nextId();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          stopWait(requestId);
          reject(fail("timeout", `Condition not met within ${timeoutMs} ms`));
        }, timeoutMs);
        waits.set(requestId, { check, resolve, reject, timer, deadline: Date.now() + timeoutMs });
        if (ready) deliver({ type: "waitFor", requestId, timeoutMs, maxNodes: waitMaxNodes });
      });
    },

    async screenshot() {
      try {
        return await transport.capture();
      } catch (err) {
        throw new BrowserHostError("capture_failed", "Could not capture the page", { cause: err });
      }
    },

    onUserRequired(cb) {
      listeners.add(cb);
    },

    readStorage() {
      return request<StorageDump>({ type: "storage.read", requestId: nextId() });
    },

    clearPageStorage() {
      if (closed) return;
      transport.evaluate(
        "(function(){try{localStorage.clear();}catch(e){}try{sessionStorage.clear();}catch(e){}})();true;",
      );
    },

    close() {
      closed = true;
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.reject(fail("closed"));
      }
      pending.clear();
      for (const [, w] of waits) {
        clearTimeout(w.timer);
        w.reject(fail("closed"));
      }
      waits.clear();
      if (navigation) {
        clearTimeout(navigation.timer);
        navigation.reject(fail("closed"));
        navigation = null;
      }
      listeners.clear();
    },
  };
  return host;
}
