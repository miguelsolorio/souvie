// Auth session storage on iOS and Android. AsyncStorage works in Expo Go and in development
// builds, so a signed-in session survives a reload in both. (The query cache uses MMKV, which
// Expo Go does not ship; see storage.native.ts.)
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { SupportedStorage } from "@supabase/supabase-js";

export const authStorage: SupportedStorage = {
  getItem: (key) => AsyncStorage.getItem(key),
  setItem: (key, value) => AsyncStorage.setItem(key, value),
  removeItem: (key) => AsyncStorage.removeItem(key),
};
