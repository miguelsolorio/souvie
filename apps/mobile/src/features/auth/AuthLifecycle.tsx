import { useSession, useSupabase } from "@mp/db";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { AppState, Platform } from "react-native";

/**
 * Renders nothing. It keeps two things in step with the auth session:
 * - On native, token auto-refresh runs only while the app is in the foreground.
 * - When a different person signs in, every cached query is dropped, so one account's
 *   households never show up under another's.
 */
export function AuthLifecycle() {
  const client = useSupabase();
  const queryClient = useQueryClient();
  const { status, user } = useSession();
  const lastUserId = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (Platform.OS === "web") return;
    client.auth.startAutoRefresh();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") client.auth.startAutoRefresh();
      else client.auth.stopAutoRefresh();
    });
    return () => {
      subscription.remove();
      client.auth.stopAutoRefresh();
    };
  }, [client]);

  useEffect(() => {
    if (status === "loading") return;
    const userId = user?.id ?? null;
    if (lastUserId.current !== undefined && lastUserId.current !== userId) {
      queryClient.clear();
    }
    lastUserId.current = userId;
  }, [status, user?.id, queryClient]);

  return null;
}
