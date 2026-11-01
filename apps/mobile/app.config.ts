// Dynamic Expo config (WS13). app.json stays the source of truth; this file layers on the one
// value that depends on where the web build is hosted.
//
// expo-router's `origin` is the address the web build is served from. It is read from
// EXPO_PUBLIC_WEB_ORIGIN, the same variable invite links use (apps/mobile/src/lib/env.ts), so the
// CI job that builds for Cloudflare Pages sets it once. It is applied only for an https origin: a
// local http://localhost value in .env.local must never reach a production bundle. Expo reads this
// file before it reads the repo-root .env.local (metro.config.js copies those values later), so on
// a laptop the origin is simply unset, which is fine for development and for the CI test build.
import type { ConfigContext, ExpoConfig } from "expo/config";

type Plugin = NonNullable<ExpoConfig["plugins"]>[number];

/** The https origin to use, or null: unset, malformed, not https, or carrying a path. */
export function webOrigin(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Adds `origin` to the expo-router plugin entry, keeping any options it already has. */
export function withRouterOrigin(
  plugins: ExpoConfig["plugins"],
  origin: string | null,
): ExpoConfig["plugins"] {
  if (!plugins || !origin) return plugins;
  return plugins.map((plugin): Plugin => {
    if (plugin === "expo-router") return ["expo-router", { origin }];
    if (Array.isArray(plugin) && plugin[0] === "expo-router") {
      return ["expo-router", { ...(plugin[1] as object | undefined), origin }];
    }
    return plugin;
  });
}

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: config.name ?? "Souvie",
  slug: config.slug ?? "souvie",
  plugins: withRouterOrigin(config.plugins, webOrigin(process.env.EXPO_PUBLIC_WEB_ORIGIN)),
});
