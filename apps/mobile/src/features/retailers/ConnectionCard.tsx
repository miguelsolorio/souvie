import { automates, KROGER_CAPABILITIES, type RetailerAdapter } from "@mp/retailers";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Button } from "../../components/Button";
import { ErrorText } from "../../components/Screen";
import { confirmAction } from "../../lib/confirm";
import { type RetailerConnection, retailerErrorMessage } from "./api";
import { ConnectKroger } from "./ConnectKroger";
import { StorePicker } from "./StorePicker";
import { useDisconnectRetailer, useUpdateConnection } from "./useRetailerConnection";

const STATUS_TEXT: Record<RetailerConnection["status"], string> = {
  active: "Connected",
  needs_reauth: "Needs you to sign in again",
  revoked: "Disconnected",
};

/** What happens with this store, from its capability row (docs/04 §Per-retailer adapter plan). */
export function capabilityLine(capabilities: RetailerAdapter["capabilities"]): string {
  const fills = automates(capabilities, "cartAdd")
    ? "Your list goes straight into your Kroger cart."
    : "You get a list to add to your cart yourself.";
  const pays =
    capabilities.checkout === "handoff"
      ? "You pick a time and pay in the QFC or Fred Meyer app, or on the website."
      : "Checkout happens here once you approve it.";
  return `${fills} ${pays}`;
}

/**
 * A Kroger connection: its status, store, and pickup or delivery, with the actions the account
 * holder or a household owner may take. Disconnect deletes the stored key on our side.
 */
export function ConnectionCard({
  connection,
  isHolder,
  isOwner,
  zip,
}: {
  connection: RetailerConnection;
  /** The signed-in member owns this Kroger account. */
  isHolder: boolean;
  isOwner: boolean;
  zip?: string | null | undefined;
}) {
  const householdId = connection.householdId;
  const update = useUpdateConnection(householdId);
  const disconnect = useDisconnectRetailer(householdId);
  const [picking, setPicking] = useState(false);
  const canManage = isHolder || isOwner;
  const error = update.error ?? disconnect.error;

  async function confirmDisconnect() {
    const ok = await confirmAction({
      title: "Disconnect Kroger",
      message:
        "We delete the key that lets us add to this cart. Your Kroger account and cart stay as they are.",
      confirmLabel: "Disconnect",
      destructive: true,
    });
    if (ok) disconnect.mutate(connection.id);
  }

  return (
    <View className="gap-3 rounded-xl border border-neutral-200 p-4" testID="connection-card">
      <View className="gap-1">
        <Text className="text-base font-semibold text-neutral-900">Kroger account</Text>
        <Text
          testID="connection-status"
          className={`text-sm ${connection.status === "active" ? "text-brand" : "text-red-700"}`}
        >
          {STATUS_TEXT[connection.status]}
          {isHolder ? " (yours)" : ""}
        </Text>
        <Text className="text-sm text-neutral-700">
          {connection.storeName ?? "No store chosen yet"}
        </Text>
        <Text className="text-xs text-neutral-500">{capabilityLine(KROGER_CAPABILITIES)}</Text>
      </View>

      {canManage && connection.status !== "revoked" ? (
        <View accessibilityRole="radiogroup" className="flex-row gap-2">
          {(["pickup", "delivery"] as const).map((m) => {
            const selected = connection.modality === m;
            return (
              <Pressable
                key={m}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                onPress={() => update.mutate({ connectionId: connection.id, modality: m })}
                className={`rounded-full border px-4 py-2 ${selected ? "border-brand bg-brand/10" : "border-neutral-300"}`}
              >
                <Text className="text-sm text-neutral-900">
                  {m === "pickup" ? "Pickup" : "Delivery"}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {canManage && connection.status !== "revoked" ? (
        picking ? (
          <StorePicker
            initialZip={zip}
            selectedId={connection.storeId}
            onSelect={(store) => {
              update.mutate(
                { connectionId: connection.id, store: { id: store.id, name: store.name } },
                { onSuccess: () => setPicking(false) },
              );
            }}
          />
        ) : (
          <Button label="Change store" variant="secondary" onPress={() => setPicking(true)} />
        )
      ) : null}

      {isHolder && connection.status !== "active" ? (
        <ConnectKroger householdId={householdId} label="Sign in to Kroger again" />
      ) : null}

      {canManage && connection.status !== "revoked" ? (
        <Button
          testID="disconnect-kroger"
          label="Disconnect"
          variant="danger"
          loading={disconnect.isPending}
          onPress={() => void confirmDisconnect()}
        />
      ) : null}

      <ErrorText>{error ? retailerErrorMessage(error) : null}</ErrorText>
    </View>
  );
}
