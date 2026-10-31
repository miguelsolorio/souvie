import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback } from "react";
import { isEditParam, nextHref, previousHref } from "./onboardingState";
import { combineNotice, noticeFromParam, type RecheckNotice } from "./planRecheck";

/**
 * Forward and back for one screen. Both replace the route instead of pushing, so the history is
 * the same whether the person walked here or the app reopened on this screen after a quit.
 *
 * With `?edit=1` (opened from household settings by someone who finished onboarding) the walk is
 * the food preference screens only: Continue goes to the next of them, then back to settings, and
 * Back on the first returns to settings. A `notice` (the result of re-checking the planned weeks)
 * rides along in the URL until the walk ends; `goNext` may add one, and "updated" is never
 * replaced by a later "same".
 */
export function useStepNav(step: number) {
  const router = useRouter();
  const { edit: editParam, notice: noticeParam } = useLocalSearchParams<{
    edit?: string;
    notice?: string;
  }>();
  const editing = isEditParam(editParam);
  const notice = noticeFromParam(noticeParam);
  const previous = previousHref(step, editing, notice);

  const goNext = useCallback(
    (result?: RecheckNotice | null) => {
      const added = result === "updated" || result === "same" ? result : null;
      const next = nextHref(step, editing, combineNotice(notice, added));
      if (next) router.replace(next);
    },
    [router, step, editing, notice],
  );

  const goBack = useCallback(() => {
    if (previous) router.replace(previous);
  }, [router, previous]);

  return { goNext, goBack: previous ? goBack : undefined, editing, notice };
}
