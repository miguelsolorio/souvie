// A Tier 3 (browser session) connection: which store, its state, and Disconnect for the person whose
// account it is (WS08). ConnectionCard (features/retailers) hands Tier 3 rows to this card.
// Disconnect clears this phone's WebView cookie store and secure-store entry, deletes the key from
// Vault, and marks the connection revoked. Only the account holder can: the session is on their
// phone.
import type { Tier3RetailerId } from "@mp/retailers";
import { Text, View } from "react-native";
import { Button } from "../../components/Button";
import { confirmAction } from "../../lib/confirm";
import { tier3ErrorMessage, useDisconnectTier3 } from "./api";
import { retailerDisplayName } from "./stores";

export interface Tier3ConnectionLike {
  id: string;
  householdId: string;
  retailer: string;
  status: "active" | "needs_reauth" | "revoked";
  storeName: string | null;
}

const STATUS_TEXT: Record<Tier3ConnectionLike["status"], string> = {
  active: "Connected",
  needs_reauth: "Needs you to sign in again",
  revoked: "Disconnected",
};

export function disconnectNote(name: string): string {
  return `Souvie clears the ${name} session from this phone and deletes its key from our vault. Your ${name} account itself is untouched; sign out there too if you want to end the session on their side.`;
}

export function capabilityNote(name: string): string {
  return `Souvie fills your cart on ${name}'s own site in this app and stops at the pay button for your tap.`;
}

export function Tier3ConnectionCard({
  connection,
  isHolder,
  onSignInAgain,
}: {
  connection: Tier3ConnectionLike;
  /** The signed-in member owns this store account. */
  isHolder: boolean;
  onSignInAgain?: () => void;
}) {
  const name = retailerDisplayName(connection.retailer as Tier3RetailerId);
  const disconnect = useDisconnectTier3(connection.householdId);

  async function confirmDisconnect() {
    const ok = await confirmAction({
      title: `Disconnect ${name}`,
      message: disconnectNote(name),
      confirmLabel: "Disconnect",
      destructive: true,
    });
    if (ok) disconnect.mutate(connection.id);
  }

  return (
    <View className="gap-3 rounded-xl border border-neutral-200 p-4" testID="tier3-connection-card">
      <View className="gap-1">
        <Text className="text-base font-semibold text-neutral-900">{name} account</Text>
        <Text
          testID="tier3-connection-status"
          className={`text-sm ${connection.status === "active" ? "text-brand" : "text-red-700"}`}
        >
          {STATUS_TEXT[connection.status]}
          {isHolder ? " (yours)" : ""}
        </Text>
        {connection.storeName ? (
          <Text className="text-sm text-neutral-700">{connection.storeName}</Text>
        ) : null}
        <Text className="text-xs text-neutral-500">{capabilityNote(name)}</Text>
      </View>

      {isHolder && connection.status === "needs_reauth" && onSignInAgain ? (
        <Button label={`Sign in to ${name} again`} onPress={onSignInAgain} />
      ) : null}

      {isHolder && connection.status !== "revoked" ? (
        <View className="gap-1">
          <Button
            testID="disconnect-tier3"
            label="Disconnect"
            variant="danger"
            loading={disconnect.isPending}
            onPress={() => void confirmDisconnect()}
          />
          <Text className="text-xs text-neutral-500">{disconnectNote(name)}</Text>
        </View>
      ) : null}

      {disconnect.isError ? (
        <Text accessibilityRole="alert" className="text-sm text-red-700">
          {tier3ErrorMessage(disconnect.error)}
        </Text>
      ) : null}
    </View>
  );
}
