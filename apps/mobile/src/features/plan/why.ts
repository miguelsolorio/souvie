// The one-line "why this" for an entry, when the suggestion engine gave one (docs/03 §3: each
// composed entry carries a short reason). The entries table has no column for it and the planner
// does not add one, so the reason lives here, in memory, for as long as the app is open. The entry
// sheet shows it when present and leaves its slot empty otherwise. WS06 can persist it later.
import { useSyncExternalStore } from "react";

const reasons = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;

function notify() {
  version += 1;
  for (const listener of listeners) listener();
}

export function setEntryWhy(entryId: string, why: string | null | undefined): void {
  const text = why?.trim();
  if (text) reasons.set(entryId, text);
  else reasons.delete(entryId);
  notify();
}

export function getEntryWhy(entryId: string): string | undefined {
  return reasons.get(entryId);
}

/** The reason for an entry, or undefined. Re-renders when it changes. */
export function useEntryWhy(entryId: string | null | undefined): string | undefined {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
    () => version,
  );
  return entryId ? reasons.get(entryId) : undefined;
}
