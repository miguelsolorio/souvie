import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback } from "react";
import { isEditParam, nextHref, previousHref } from "./onboardingState";

/**
 * Forward and back for one screen. Both replace the route instead of pushing, so the history is
 * the same whether the person walked here or the app reopened on this screen after a quit.
 *
 * With `?edit=1` (opened from household settings by someone who finished onboarding) the walk is
 * the food preference screens only: Continue goes to the next of them, then back to settings, and
 * Back on the first returns to settings.
 */
export function useStepNav(step: number) {
  const router = useRouter();
  const { edit: editParam } = useLocalSearchParams<{ edit?: string }>();
  const editing = isEditParam(editParam);
  const next = nextHref(step, editing);
  const previous = previousHref(step, editing);

  const goNext = useCallback(() => {
    if (next) router.replace(next);
  }, [router, next]);

  const goBack = useCallback(() => {
    if (previous) router.replace(previous);
  }, [router, previous]);

  return { goNext, goBack: previous ? goBack : undefined, editing };
}
