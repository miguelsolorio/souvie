// Household settings: the household's Tier 3 stores (WS08). Each connection shows its card with
// Disconnect; a store with no connection offers Connect, which runs the connect flow (consent once,
// then the store's own sign-in). Beside KrogerSettingsSection, which does the same for Kroger.
import { useSession, useSupabase } from "@mp/db";
import { useState } from "react";
import { Text, View } from "react-native";
import { Button } from "../../components/Button";
import { ConnectTier3 } from "../retailers/ConnectTier3";
import { useTier3Connections } from "./api";
import { TIER3_STORES, type Tier3Store } from "./stores";
import { Tier3ConnectionCard } from "./Tier3ConnectionCard";

export function Tier3SettingsSection({ householdId }: { householdId: string }) {
  const client = useSupabase();
  const { user } = useSession();
  const connections = useTier3Connections(client, householdId);
  const [connecting, setConnecting] = useState<Tier3Store | null>(null);

  if (connections.isPending) return <Text className="text-sm text-neutral-500">Loading</Text>;

  if (connecting) {
    return (
      <ConnectTier3
        householdId={householdId}
        store={connecting}
        onConnected={() => setConnecting(null)}
        onCancel={() => setConnecting(null)}
      />
    );
  }

  const list = (connections.data ?? []).filter((c) => c.status !== "revoked");
  const mine = new Set(list.filter((c) => c.userId === user?.id).map((c) => c.retailer));

  return (
    <View className="gap-4" testID="tier3-settings">
      <Text className="text-sm text-neutral-600">
        Souvie can shop these stores on their own websites, in this app, while you watch. You sign
        in on the store's page and tap pay yourself.
      </Text>
      {list.map((c) => (
        <Tier3ConnectionCard
          key={c.id}
          connection={c}
          isHolder={c.userId === user?.id}
          onSignInAgain={() => {
            const store = TIER3_STORES.find((s) => s.retailer === c.retailer);
            if (store) setConnecting(store);
          }}
        />
      ))}
      <View className="gap-2">
        {TIER3_STORES.filter((s) => !mine.has(s.retailer)).map((store) => (
          <Button
            key={store.id}
            testID={`connect-tier3-${store.id}`}
            label={`Connect ${store.name}`}
            variant="secondary"
            onPress={() => setConnecting(store)}
          />
        ))}
      </View>
    </View>
  );
}
