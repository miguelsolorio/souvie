// The phone version of desktop.ts: there is no desktop shell on iOS or Android, so nothing here
// does anything and no Tauri package is bundled.

export function isDesktopShell(): boolean {
  return false;
}

export async function openInSystemBrowser(_url: string): Promise<void> {
  throw new Error("There is no desktop shell on a phone.");
}

export async function onDesktopDeepLink(_handler: (urls: string[]) => void): Promise<() => void> {
  return () => {};
}
