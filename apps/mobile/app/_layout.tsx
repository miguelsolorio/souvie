import "../global.css";

import { SupabaseProvider } from "@mp/db";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Text, View } from "react-native";
import { AuthLifecycle } from "../src/features/auth/AuthLifecycle";
import { persistOptions, queryClient } from "../src/lib/queryClient";
import { getSupabase, isSupabaseConfigured } from "../src/lib/supabase";

function NotConfigured() {
  return (
    <View className="flex-1 items-center justify-center gap-2 bg-white px-6">
      <Text className="text-2xl font-bold text-brand">Souvie</Text>
      <Text testID="backend-status" className="text-center text-sm text-neutral-600">
        Backend: not configured. Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY in
        .env.local (see .env.example).
      </Text>
    </View>
  );
}

export default function RootLayout() {
  return (
    <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>
      {isSupabaseConfigured ? (
        <SupabaseProvider client={getSupabase()}>
          <AuthLifecycle />
          <Stack screenOptions={{ headerShown: false }} />
        </SupabaseProvider>
      ) : (
        <NotConfigured />
      )}
      <StatusBar style="auto" />
    </PersistQueryClientProvider>
  );
}
