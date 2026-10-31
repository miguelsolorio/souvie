import { useHousehold, useSupabase } from "@mp/db";
import { useQuery } from "@tanstack/react-query";
import { Redirect, useRouter } from "expo-router";
import { Text, View } from "react-native";
import { Button } from "../../src/components/Button";
import { LoadingScreen, Screen } from "../../src/components/Screen";
import { CREATE_HOUSEHOLD_ROUTE } from "../../src/features/auth/routes";
import { PLAN_ROUTE } from "../../src/features/plan/routes";

interface Health {
  ok: boolean;
  version: string;
}

/** Calls the `health` Edge Function so the screen proves the app reaches Supabase (WS00). */
function useBackendHealth() {
  const client = useSupabase();
  return useQuery({
    queryKey: ["health"],
    retry: false,
    queryFn: async () => {
      const { data, error } = await client.functions.invoke<Health>("health", { method: "GET" });
      if (error) throw error;
      return data;
    },
  });
}

function backendLabel(health: ReturnType<typeof useBackendHealth>): string {
  if (health.isPending) return "Backend: checking";
  if (health.isError) return "Backend: unreachable";
  return `Backend: ok, version ${health.data?.version ?? "unknown"}`;
}

/**
 * The menu: where the planner (the home screen) sends people for everything that is not the week
 * itself. It was the signed-in landing screen before the planner (WS04) took over the home route.
 */
export default function Menu() {
  const router = useRouter();
  const household = useHousehold();
  const health = useBackendHealth();

  if (household.isPending) return <LoadingScreen />;

  if (household.isError) {
    return (
      <Screen title="Souvie">
        <Text accessibilityRole="alert" className="text-base text-red-700">
          Could not load your household.
        </Text>
        <Button label="Try again" onPress={() => void household.refetch()} />
      </Screen>
    );
  }

  if (!household.data) return <Redirect href={CREATE_HOUSEHOLD_ROUTE} />;

  return (
    <Screen
      title={household.data.name}
      subtitle={household.data.role === "owner" ? "You are the owner." : "You are a member."}
    >
      <View className="gap-3">
        <Button testID="open-plan" label="Weekly plan" onPress={() => router.push(PLAN_ROUTE)} />
        <Button
          testID="open-recipes"
          label="Recipes"
          variant="secondary"
          onPress={() => router.push("/recipes")}
        />
        <Button
          testID="open-household-settings"
          label="Household and members"
          variant="secondary"
          onPress={() => router.push("/household/settings")}
        />
        <Button
          testID="open-profile"
          label="Profile"
          variant="secondary"
          onPress={() => router.push("/profile")}
        />
      </View>
      <Text testID="backend-status" className="text-xs text-neutral-500">
        {backendLabel(health)}
      </Text>
    </Screen>
  );
}
