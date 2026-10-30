import { useCallback, useEffect, useRef, useState } from "react";

export const COMMIT_DELAY_MS = 400;

/**
 * A number the person is adjusting with plus and minus. Each press shows at once; the change is
 * committed once, a moment after the last press. Three quick presses on plus are one save of the
 * final number, not three saves racing each other.
 *
 * `value` is what the app currently has (the optimistic copy in the query cache). While a draft
 * exists the draft is shown. The draft is dropped when `value` changes, which is the commit
 * arriving, a rollback if it failed, or another member's edit. Closing the screen commits what is
 * pending.
 */
export function useDraftNumber(
  value: number,
  commit: (next: number) => void,
  delayMs: number = COMMIT_DELAY_MS,
) {
  const [draft, setDraft] = useState<number | null>(null);
  const draftRef = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef({ value, commit });
  latest.current = { value, commit };

  const settle = useCallback(() => {
    timer.current = undefined;
    const pending = draftRef.current;
    if (pending !== null && pending !== latest.current.value) {
      latest.current.commit(pending);
      return; // the draft stays until `value` catches up
    }
    draftRef.current = null;
    setDraft(null);
  }, []);

  const flush = useCallback(() => {
    if (timer.current !== undefined) {
      clearTimeout(timer.current);
      settle();
    }
  }, [settle]);

  const change = useCallback(
    (next: number) => {
      draftRef.current = next;
      setDraft(next);
      if (timer.current !== undefined) clearTimeout(timer.current);
      timer.current = setTimeout(settle, delayMs);
    },
    [settle, delayMs],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new `value` is the signal to drop the draft.
  useEffect(() => {
    if (timer.current === undefined) {
      draftRef.current = null;
      setDraft(null);
    }
  }, [value]);

  useEffect(() => flush, [flush]);

  return { value: draft ?? value, change, flush };
}
