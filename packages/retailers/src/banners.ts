// Kroger banners we brand: the consent screen (`banner=` on the authorize URL) and the
// Add-to-Cart UI. Shared by the adapter and the app, so it lives outside kroger/.
import type { Banner } from "./types.ts";

/** Kroger chain codes, as Locations returns them, to their display names. */
export const BANNER_CHAIN_NAMES: Readonly<Record<string, string>> = Object.freeze({
  QFC: "QFC",
  FRED: "Fred Meyer",
});

/** The consent-screen banner for a Kroger chain code. Undefined for chains we do not brand. */
export function bannerForChain(chain: string | null | undefined): Banner | undefined {
  const code = chain?.trim().toUpperCase() ?? "";
  if (code === "QFC") return "qfc";
  if (code === "FRED" || code.startsWith("FRED MEYER")) return "fredmeyer";
  return undefined;
}
