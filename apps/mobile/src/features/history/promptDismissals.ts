// Runs whose "Did you place this order?" banner the person closed (WS12). Kept on this device only:
// it is a convenience, not a fact about the order. Nothing is written to the database, and a run
// the person never answered still shows the question on its own screen. The storage can be
// missing or throw (private window, full disk), so every read and write is guarded.
import type { KeyValueStorage } from "../../lib/storage.types";

const KEY = "mp-order-prompt-dismissed";
const MAX = 50;

export function readDismissed(storage: KeyValueStorage): string[] {
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string").slice(-MAX)
      : [];
  } catch {
    return [];
  }
}

/** Remembers a dismissal and returns the list now stored. */
export function dismissRun(storage: KeyValueStorage, runId: string): string[] {
  const next = [...readDismissed(storage).filter((id) => id !== runId), runId].slice(-MAX);
  try {
    storage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Not saved: the banner comes back next launch, which is harmless.
  }
  return next;
}
