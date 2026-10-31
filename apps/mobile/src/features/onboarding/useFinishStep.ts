import { useCallback, useState } from "react";
import { shouldRecheckPlan } from "./planRecheck";
import { useStepNav } from "./useStepNav";
import { usePlanRecheck } from "./useSuggestWeek";

/** Shown when the answers saved but the planned weeks could not be checked against them. */
export const RECHECK_FAILED_MESSAGE =
  "Your answers are saved, but we could not check your plan against them. Try again.";

/**
 * `useStepNav` for the screens whose answers change which dinners are allowed (3 and 4). In edit
 * mode, `finish` re-checks the current and coming week before moving on, so a dinner that a new
 * allergy or diet rules out is replaced or removed, and passes the result to the next screen. Out
 * of edit mode it just moves on. It returns the error text to show, or null once it has moved on.
 * Call it after the answers have saved; calling it again after a failure is safe.
 */
export function useFinishStep(step: number) {
  const nav = useStepNav(step);
  const recheck = usePlanRecheck();
  const [checking, setChecking] = useState(false);
  const { goNext, editing } = nav;

  const finish = useCallback(async (): Promise<string | null> => {
    if (!shouldRecheckPlan(step, editing)) {
      goNext();
      return null;
    }
    setChecking(true);
    try {
      const result = await recheck();
      goNext(result.notice);
      return null;
    } catch {
      return RECHECK_FAILED_MESSAGE;
    } finally {
      setChecking(false);
    }
  }, [step, editing, goNext, recheck]);

  return { ...nav, finish, checking };
}
