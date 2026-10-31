// A one-line notice the planner shows when a save fails after the screen that started it is gone
// (add a recipe in the picker, close the picker, the connection drops). A module-level store, read
// with useSyncExternalStore, so any planner screen or sheet can show the same message.
import { useSyncExternalStore } from "react";

export interface PlanNoticeState {
  message: string | null;
  /** Bumps on every notice so an identical message shown twice still re-renders. */
  id: number;
}

export const NOTICE_DURATION_MS = 8000;

let state: PlanNoticeState = { message: null, id: 0 };
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function set(next: PlanNoticeState) {
  state = next;
  for (const listener of listeners) listener();
}

export function showPlanNotice(message: string): void {
  if (timer !== undefined) clearTimeout(timer);
  set({ message, id: state.id + 1 });
  timer = setTimeout(clearPlanNotice, NOTICE_DURATION_MS);
}

export function clearPlanNotice(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  if (state.message !== null) set({ message: null, id: state.id });
}

export function getPlanNotice(): PlanNoticeState {
  return state;
}

export function usePlanNotice(): PlanNoticeState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getPlanNotice,
    getPlanNotice,
  );
}
