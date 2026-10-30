import { getShareExtensionKey } from "expo-share-intent";

/**
 * Expo Router calls this for every link that opens the app. The iOS share extension opens
 * `mealplanner://dataUrl=mealplannerShareKey`, which matches no route. Send it to the home route;
 * the ShareIntentReceiver (src/features/recipes) reads the shared content and opens the add-recipe
 * screen. Every other link passes through unchanged.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    if (path.includes(`dataUrl=${getShareExtensionKey()}`)) return "/";
  } catch {
    // No scheme to compare with (web). Fall through.
  }
  return path;
}
