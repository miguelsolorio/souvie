// Native storage for the persisted query cache: MMKV in development and production builds.
// Expo Go does not ship react-native-mmkv (a Nitro module), so it falls back to memory there.
import Constants, { ExecutionEnvironment } from "expo-constants";
import { createMemoryStorage, type KeyValueStorage } from "./storage.types";

function mmkvStorage(): KeyValueStorage | null {
  if (Constants.executionEnvironment === ExecutionEnvironment.StoreClient) return null;
  try {
    // Loaded lazily so Expo Go never evaluates the native module.
    const { createMMKV } = require("react-native-mmkv") as typeof import("react-native-mmkv");
    const mmkv = createMMKV({ id: "mp-query-cache" });
    return {
      getItem: (key) => mmkv.getString(key) ?? null,
      setItem: (key, value) => mmkv.set(key, value),
      removeItem: (key) => {
        mmkv.remove(key);
      },
    };
  } catch (error) {
    console.warn("MMKV unavailable; the query cache will not persist.", error);
    return null;
  }
}

export const kvStorage: KeyValueStorage = mmkvStorage() ?? createMemoryStorage();
