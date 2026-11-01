import { useRouter } from "expo-router";
import { useShareIntent } from "expo-share-intent";
import { useEffect } from "react";
import { setSharedInput, toSharedInput } from "./sharedInbox";

/**
 * Receives what other apps share into this one (WS02, acceptance criterion 7). Mounted once, below
 * the session guard, so a share that arrives while signed out waits and is read after sign-in.
 *
 * On iOS the share extension opens the app with a `souvie://dataUrl=...` link (app/+native-intent.tsx
 * sends that link to the home route instead of a not-found screen) and the expo-share-intent
 * module hands the content to this hook. On Android the hook reads the Intent directly. On web
 * the hook is off. Expo Go has no share extension; use a development build.
 *
 * Only text and links are taken: the plugin in app.json registers no image, movie, or file types,
 * and `toSharedInput` drops media. The caption goes to the add screen through the inbox; nothing is
 * fetched here, from any platform (R11).
 */
export function ShareIntentReceiver() {
  const router = useRouter();
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntent();

  useEffect(() => {
    if (!hasShareIntent) return;
    const input = toSharedInput(shareIntent);
    resetShareIntent();
    if (!input) return;
    setSharedInput(input);
    router.navigate("/recipes/new");
  }, [hasShareIntent, shareIntent, resetShareIntent, router]);

  return null;
}
