/**
 * The web and desktop version of the share receiver (WS13): nothing. A browser tab has no share
 * sheet to receive from, so nothing can be shared into it. The add-recipe screen says so and
 * points at the Link and Paste tabs instead (shareCapability.ts). Mounting this keeps
 * `app/(app)/_layout.tsx` the same on every platform; expo-share-intent is not in the web bundle.
 *
 * The phone version, which reads what other apps share in, is ShareIntentReceiver.native.tsx.
 */
export function ShareIntentReceiver() {
  return null;
}
