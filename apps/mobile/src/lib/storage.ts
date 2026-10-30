// Web storage for the persisted query cache. Metro picks storage.native.ts on iOS and
// Android; this file serves web and is what TypeScript and Vitest resolve.
import { createMemoryStorage, type KeyValueStorage } from "./storage.types";

function browserStorage(): KeyValueStorage | null {
  // The static export renders every route in Node, where there is no window.
  if (typeof window === "undefined") return null;
  try {
    const probe = "__mp_storage_probe__";
    window.localStorage.setItem(probe, probe);
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    // Storage disabled or full (private mode, quota). Fall back to memory.
    return null;
  }
}

export const kvStorage: KeyValueStorage = browserStorage() ?? createMemoryStorage();
