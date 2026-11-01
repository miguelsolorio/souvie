import { useHousehold, useSession } from "@mp/db";
import { useRouter } from "expo-router";
import { Text, View } from "react-native";
import { Button } from "../../components/Button";
import { useFlag } from "../../observability/useFlag";
import { useRetailerConnection } from "../retailers/useRetailerConnection";
import { runRoute } from "./routes";
import { useStartRun } from "./useShoppingRun";

/**
 * "Shop this list" on the grocery list: starts a run at the household's store connection and opens
 * it. Nothing reaches the store cart until the person approves the proposal.
 */
export function ShopThisList({ listId }: { listId: string }) {
  const router = useRouter();
  const household = useHousehold();
  const session = useSession();
  const { connection } = useRetailerConnection(household.data?.id, session.user?.id);
  const start = useStartRun();
  // The kill switch (docs/05 §Incident basics): on unless PostHog says off.
  const agentEnabled = useFlag("shopping_agent_enabled");

  if (!agentEnabled) {
    return (
      <Text testID="shop-paused" className="text-sm text-neutral-500">
        Shopping is paused right now. Your list is safe. Try again later.
      </Text>
    );
  }

  if (!connection) {
    return (
      <Text testID="shop-no-store" className="text-sm text-neutral-500">
        Connect a store in household settings to have the shopper fill your cart.
      </Text>
    );
  }

  return (
    <View className="gap-2">
      {start.error ? (
        <Text accessibilityRole="alert" className="text-sm text-red-700">
          {start.error.message}
        </Text>
      ) : null}
      <Button
        testID="shop-this-list"
        label="Shop this list"
        loading={start.isPending}
        disabled={connection.status !== "active"}
        onPress={() =>
          start.mutate(
            { listId, connectionId: connection.id },
            { onSuccess: (runId) => router.push(runRoute(runId)) },
          )
        }
      />
      <Text className="text-xs text-neutral-500">
        {connection.storeName ? `At ${connection.storeName}. ` : ""}You review the cart before
        anything is added.
      </Text>
    </View>
  );
}
