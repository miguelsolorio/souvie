import type { Page } from "@playwright/test";

// A stand-in for the part of Tauri the web page can see: `window.__TAURI_INTERNALS__`. The real
// @tauri-apps/plugin-opener and plugin-deep-link packages are what the app loads; they call
// `invoke` and `transformCallback` on this object exactly as they do in the desktop window. So a
// test here proves the app speaks the plugins' real command names and event names, which the
// capability file (apps/desktop/src-tauri/capabilities/default.json) has to allow.

export interface TauriInvoke {
  cmd: string;
  args: Record<string, unknown>;
}

export const DEEP_LINK_EVENT = "deep-link://new-url";

/** Installs the stub before any page script runs. Call before `page.goto`. */
export async function installTauriStub(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Handler = (event: { event: string; id: number; payload: unknown }) => void;
    const callbacks = new Map<number, Handler>();
    const listeners = new Map<string, Array<{ id: number; handler: number }>>();
    const invokes: Array<{ cmd: string; args: Record<string, unknown> }> = [];
    let next = 1;

    const stub = {
      metadata: {
        currentWindow: { label: "main" },
        currentWebview: { windowLabel: "main", label: "main" },
      },
      transformCallback(callback: Handler) {
        const id = next++;
        callbacks.set(id, callback);
        return id;
      },
      unregisterCallback(id: number) {
        callbacks.delete(id);
      },
      async invoke(cmd: string, args: Record<string, unknown> = {}) {
        invokes.push({ cmd, args });
        if (cmd === "plugin:event|listen") {
          const event = String(args.event);
          const entry = { id: next++, handler: Number(args.handler) };
          listeners.set(event, [...(listeners.get(event) ?? []), entry]);
          return entry.id;
        }
        if (cmd === "plugin:event|unlisten") {
          const event = String(args.event);
          listeners.set(
            event,
            (listeners.get(event) ?? []).filter((entry) => entry.id !== args.eventId),
          );
          return null;
        }
        // plugin:deep-link|get_current: the app was not launched by a link. open_url: nothing to open.
        return null;
      },
    };

    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: stub, configurable: true });
    // The event package also looks here when a listener is removed.
    Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
      value: { unregisterListener() {} },
      configurable: true,
    });
    Object.defineProperty(window, "__tauriTest", {
      value: {
        invokes,
        /** What the operating system does when it opens a souvie:// link in the app. */
        emit(event: string, payload: unknown) {
          for (const entry of listeners.get(event) ?? []) {
            callbacks.get(entry.handler)?.({ event, id: entry.id, payload });
          }
        },
        listening(event: string) {
          return (listeners.get(event) ?? []).length;
        },
      },
      configurable: true,
    });
  });
}

type TauriTest = {
  invokes: TauriInvoke[];
  emit(event: string, payload: unknown): void;
  listening(event: string): number;
};

/** Every command the page sent to the shell so far. */
export function tauriInvokes(page: Page): Promise<TauriInvoke[]> {
  return page.evaluate(() => (window as unknown as { __tauriTest: TauriTest }).__tauriTest.invokes);
}

/** Pretends the operating system opened `url` in the app. */
export function emitDeepLink(page: Page, url: string): Promise<void> {
  return page.evaluate(
    ({ event, url }) =>
      (window as unknown as { __tauriTest: TauriTest }).__tauriTest.emit(event, [url]),
    { event: DEEP_LINK_EVENT, url },
  );
}

export function deepLinkListeners(page: Page): Promise<number> {
  return page.evaluate(
    (event) => (window as unknown as { __tauriTest: TauriTest }).__tauriTest.listening(event),
    DEEP_LINK_EVENT,
  );
}
