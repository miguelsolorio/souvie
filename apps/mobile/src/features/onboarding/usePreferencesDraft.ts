import type { ProfilePreferences } from "@mp/core";
import { useCallback, useState } from "react";
import { draftFromPreferences } from "./onboardingState";

/**
 * The form state for one onboarding screen. It starts from the defaults with the person's saved
 * answers on top, changes only in memory, and never writes anything: a screen saves its own keys
 * through `useOnboarding().saveStep`. Until the person edits a field, the draft follows the saved
 * value, so a screen that opens before the profile loads shows the right answers once it does.
 */
export function usePreferencesDraft(saved: ProfilePreferences | null | undefined) {
  const [edits, setEdits] = useState<ProfilePreferences>({});
  const draft = { ...draftFromPreferences(saved), ...edits };

  const set = useCallback(
    <K extends keyof ProfilePreferences>(key: K, value: ProfilePreferences[K]) => {
      setEdits((current) => ({ ...current, [key]: value }));
    },
    [],
  );

  const reset = useCallback(() => setEdits({}), []);

  return { draft, set, reset, dirty: Object.keys(edits).length > 0 };
}
