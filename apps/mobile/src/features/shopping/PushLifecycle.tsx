// Push notifications on the web: none. The web app has no Expo push token, and leaving
// expo-notifications out of the web bundle keeps it from touching browser storage at all. The
// phone version is PushLifecycle.native.tsx.
export function PushLifecycle() {
  return null;
}
