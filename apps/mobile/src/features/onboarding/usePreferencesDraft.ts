import type { ProfilePreferences } from "@mp/core";
import { useCallback, useRef, useState } from "react";
import { draftFromPreferences } from "./onboardingState";

/**
 * The form state for one onboarding screen. It starts from the defaults with the person's saved
 * answers on top, changes only in memory, and never writes anything: a screen saves its own keys
 * through `useOnboarding().saveStep`. Until the person edits a field, the draft follows the saved
 * value, so a screen that opens before the profile loads shows the right answers once it does.
 *
 * `set` replaces a value. `update` computes the new value from the latest one, so two quick taps
 * on two chips both count (a toggle that reads the value from the last render would lose one).
 */
export function usePreferencesDraft(saved: ProfilePreferences | null | undefined) {
  const [edits, setEdits] = useState<ProfilePreferences>({});
  const base = draftFromPreferences(saved);
  const baseRef = useRef(base);
  baseRef.current = base;
  const draft = { ...base, ...edits };

  const set = useCallback(
    <K extends keyof ProfilePreferences>(key: K, value: ProfilePreferences[K]) => {
      setEdits((current) => ({ ...current, [key]: value }));
    },
    [],
  );

  const update = useCallback(
    <K extends keyof ProfilePreferences>(
      key: K,
      next: (current: ProfilePreferences[K]) => ProfilePreferences[K],
    ) => {
      setEdits((current) => ({
        ...current,
        [key]: next(key in current ? current[key] : baseRef.current[key]),
      }));
    },
    [],
  );

  const reset = useCallback(() => setEdits({}), []);

  return { draft, set, update, reset, dirty: Object.keys(edits).length > 0 };
}
