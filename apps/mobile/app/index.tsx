import { useQuery } from "@tanstack/react-query";
import { Text, View } from "react-native";
import { getSupabase, isSupabaseConfigured } from "../src/lib/supabase";

interface Health {
  ok: boolean;
  version: string;
}

/** Calls the `health` Edge Function so the screen proves the app reaches Supabase. */
function useBackendHealth() {
  return useQuery({
    queryKey: ["health"],
    enabled: isSupabaseConfigured,
    retry: false,
    queryFn: async () => {
      const { data, error } = await getSupabase().functions.invoke<Health>("health", {
        method: "GET",
      });
      if (error) throw error;
      return data;
    },
  });
}

function backendLabel(health: ReturnType<typeof useBackendHealth>): string {
  if (!isSupabaseConfigured) return "Backend: not configured (see .env.example)";
  if (health.isPending) return "Backend: checking";
  if (health.isError) return "Backend: unreachable";
  return `Backend: ok, version ${health.data?.version ?? "unknown"}`;
}

export default function Home() {
  const health = useBackendHealth();

  return (
    <View className="flex-1 items-center justify-center bg-white px-6">
      <Text className="text-4xl font-bold text-brand">Meal Planner</Text>
      <Text className="mt-3 text-base text-neutral-600">Placeholder screen</Text>
      <Text testID="backend-status" className="mt-8 text-xs text-neutral-500">
        {backendLabel(health)}
      </Text>
    </View>
  );
}
