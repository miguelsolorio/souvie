// Where the Supabase auth session lives on web (and in the static export, in memory).
// Metro picks authStorage.native.ts on iOS and Android; this file is what web, TypeScript, and
// Vitest resolve.
import type { SupportedStorage } from "@supabase/supabase-js";
import { kvStorage } from "./storage";

// kvStorage is localStorage in a browser and memory when there is no window or storage is
// blocked, so a signed-out render in Node never throws.
export const authStorage: SupportedStorage = {
  getItem: async (key) => kvStorage.getItem(key),
  setItem: async (key, value) => {
    kvStorage.setItem(key, value);
  },
  removeItem: async (key) => {
    kvStorage.removeItem(key);
  },
};
