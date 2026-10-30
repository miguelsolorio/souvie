// One anonymous pageview, only when EXPO_PUBLIC_POSTHOG_KEY is set (WS15 owns the real
// analytics design). No cookie, no stored id, no person profile, and Do Not Track is honored.

const CAPTURE_URL = "https://us.i.posthog.com/i/v0/e/";

export interface PageviewRequest {
  url: string;
  body: string;
}

export function pageviewRequest(
  apiKey: string,
  pageUrl: string,
  distinctId: string,
): PageviewRequest {
  return {
    url: CAPTURE_URL,
    body: JSON.stringify({
      api_key: apiKey,
      event: "$pageview",
      distinct_id: distinctId,
      properties: { $current_url: pageUrl, $process_person_profile: false },
    }),
  };
}

export function sendPageview(): void {
  const key = import.meta.env.EXPO_PUBLIC_POSTHOG_KEY;
  if (!key || navigator.doNotTrack === "1") return;
  const request = pageviewRequest(key, location.origin + location.pathname, crypto.randomUUID());
  void fetch(request.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: request.body,
    keepalive: true,
  }).catch(() => {});
}
