import { useRootNavigationState, useRouter } from "expo-router";
import { useEffect } from "react";
import { isDesktopShell, onDesktopDeepLink } from "../../lib/desktop";
import { routeForDeepLink } from "./desktopLinks";

/**
 * Renders nothing. In the desktop app it opens the route a souvie:// link means (desktopLinks.ts).
 * That is how sign-in comes back from the system browser: the browser lands on
 * souvie://callback?code=..., the operating system hands the link to this app, and the callback
 * screen swaps the code for a session. In a browser, and without the Tauri deep link plugin, it
 * does nothing. The phone version is DesktopDeepLinks.native.tsx.
 */
export function DesktopDeepLinks() {
  const router = useRouter();
  // A link can arrive before the navigator has mounted (the one that launched the app). Wait.
  const ready = Boolean(useRootNavigationState()?.key);

  useEffect(() => {
    if (!ready || !isDesktopShell()) return;
    let cancelled = false;
    let stop: (() => void) | undefined;

    onDesktopDeepLink((urls) => {
      for (const url of urls) {
        const route = routeForDeepLink(url);
        if (route) router.navigate(route);
      }
    })
      .then((unlisten) => {
        if (cancelled) unlisten();
        else stop = unlisten;
      })
      // No plugin in this shell: the app works, sign-in by email code still does.
      .catch(() => {});

    return () => {
      cancelled = true;
      stop?.();
    };
  }, [ready, router]);

  return null;
}
