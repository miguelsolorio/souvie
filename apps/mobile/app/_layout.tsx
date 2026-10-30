import "../global.css";

import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { persistOptions, queryClient } from "../src/lib/queryClient";

export default function RootLayout() {
  return (
    <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>
      <Stack screenOptions={{ headerShown: false }} />
      <StatusBar style="auto" />
    </PersistQueryClientProvider>
  );
}
