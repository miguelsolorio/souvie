import { useRouter } from "expo-router";
import { useCallback } from "react";
import { nextHref, previousHref } from "./onboardingState";

/**
 * Forward and back for one screen. Both replace the route instead of pushing, so the history is
 * the same whether the person walked here or the app reopened on this screen after a quit.
 */
export function useStepNav(step: number) {
  const router = useRouter();
  const next = nextHref(step);
  const previous = previousHref(step);

  const goNext = useCallback(() => {
    if (next) router.replace(next);
  }, [router, next]);

  const goBack = useCallback(() => {
    if (previous) router.replace(previous);
  }, [router, previous]);

  return { goNext, goBack: previous ? goBack : undefined };
}
