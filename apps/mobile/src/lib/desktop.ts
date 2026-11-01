// The desktop shell, seen from the web build (WS13). The same static export runs in a browser and
// inside the Tauri window (apps/desktop). This file is how the app tells the two apart and how it
// asks the shell for the two things a web page cannot do: open the system browser, and hear about
// a souvie:// link the operating system hands to the app.
//
// Metro picks desktop.native.ts on iOS and Android, where there is no shell and these packages are
// never bundled. The Tauri plugin packages are loaded on first use, so a browser visitor does not
// download them.

/** Tauri adds this to `window` before any page script runs. A normal browser has none. */
export function isDesktopShell(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Opens an https address in the person's own browser. Sign-in with Google has to happen there:
 * Google refuses to sign anyone in inside an embedded web view such as the desktop window.
 */
export async function openInSystemBrowser(url: string): Promise<void> {
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

/**
 * Calls `handler` with each souvie:// link the operating system opens in the app, including the
 * one that launched it. Resolves with a function that stops listening. Rejects when the shell has
 * no deep link plugin, which the caller treats as "no deep links here".
 */
export async function onDesktopDeepLink(handler: (urls: string[]) => void): Promise<() => void> {
  const { getCurrent, onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
  const unlisten = await onOpenUrl(handler);
  const launchedWith = await getCurrent();
  if (launchedWith && launchedWith.length > 0) handler(launchedWith);
  return unlisten;
}
