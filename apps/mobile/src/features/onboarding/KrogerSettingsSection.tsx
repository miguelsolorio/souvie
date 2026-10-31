import { useSession } from "@mp/db";
import type { Store } from "@mp/retailers";
import { useState } from "react";
import { Text, View } from "react-native";
import { ConnectionCard } from "../retailers/ConnectionCard";
import { ConnectKroger } from "../retailers/ConnectKroger";
import { StorePicker } from "../retailers/StorePicker";
import { useRetailerConnection } from "../retailers/useRetailerConnection";

/**
 * Household settings: the household's Kroger connection if there is one, otherwise the store
 * picker and Connect Kroger. The same three components onboarding screen 7 mounts (WS07's), so a
 * household that skipped connecting there can do it here.
 */
export function KrogerSettingsSection({
  householdId,
  isOwner,
  zip,
}: {
  householdId: string;
  isOwner: boolean;
  zip: string | null | undefined;
}) {
  const { user } = useSession();
  const connections = useRetailerConnection(householdId, user?.id);
  const [store, setStore] = useState<Store | null>(null);

  if (connections.isPending) return <Text className="text-sm text-neutral-500">Loading</Text>;

  const shown = connections.connection;
  if (shown) {
    return (
      <ConnectionCard
        connection={shown}
        isHolder={shown.userId === user?.id}
        isOwner={isOwner}
        zip={zip}
      />
    );
  }

  return (
    <View className="gap-4">
      <Text className="text-sm text-neutral-600">
        Connect a QFC or Fred Meyer account to have Souvie add your groceries to your cart. You
        review and pay at the store's own checkout.
      </Text>
      <StorePicker initialZip={zip} selectedId={store?.id} onSelect={setStore} />
      <ConnectKroger householdId={householdId} store={store} />
    </View>
  );
}
