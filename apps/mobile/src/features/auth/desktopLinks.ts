// Turns a souvie:// link that the operating system opened in the desktop app into the route it
// means (WS13). Pure, so Vitest runs it; DesktopDeepLinks.tsx does the listening and navigating.
//
// The same links work on a phone (app/+native-intent.tsx) and on the web (the same paths under the
// site's address). Only these three first segments are taken. Anything else, from any other
// program that can open a souvie:// link, is dropped.
//
//   souvie://callback?code=<code>          sign-in finished in the system browser
//   souvie://join/<token>                  a household invite
//   souvie://oauth/kroger?code=...         the Kroger redirect (WS07)
import { parseAuthCallback } from "./links";

const PREFIX = "souvie://";
const ALLOWED_FIRST_SEGMENTS: ReadonlySet<string> = new Set(["callback", "join", "oauth"]);
const SAFE_SEGMENT = /^[A-Za-z0-9._~-]+$/;

/** The in-app route for a deep link, or null when the link is not one the app takes. */
export function routeForDeepLink(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed.toLowerCase().startsWith(PREFIX)) return null;
  const rest = trimmed.slice(PREFIX.length);

  const hashAt = rest.indexOf("#");
  const beforeHash = hashAt === -1 ? rest : rest.slice(0, hashAt);
  const queryAt = beforeHash.indexOf("?");
  const path = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
  const query = queryAt === -1 ? "" : beforeHash.slice(queryAt + 1);

  const segments = path.split("/").filter((segment) => segment.length > 0);
  const [first] = segments;
  if (!first || !ALLOWED_FIRST_SEGMENTS.has(first)) return null;
  const safe = (segment: string) =>
    SAFE_SEGMENT.test(segment) && segment !== "." && segment !== "..";
  if (!segments.every(safe)) return null;

  if (first === "callback") {
    // The callback screen reads `code` and `error` from its route, and a link that failed can
    // carry them in the #fragment instead. Move whichever it was into the query.
    const { code, error, errorDescription } = parseAuthCallback(trimmed);
    const pairs: string[] = [];
    if (code) pairs.push(`code=${encodeURIComponent(code)}`);
    if (error) pairs.push(`error=${encodeURIComponent(error)}`);
    if (errorDescription) pairs.push(`error_description=${encodeURIComponent(errorDescription)}`);
    return pairs.length > 0 ? `/callback?${pairs.join("&")}` : "/callback";
  }

  return `/${segments.join("/")}${query ? `?${query}` : ""}`;
}
