import { arrivedStatus, orderErrorMessage, useOrder, useOrderLines, useUpdateOrder } from "@mp/db";
import { formatPrice } from "@mp/retailers/kroger/terms";
import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../components/Button";
import { LoadingScreen } from "../../components/Screen";
import { confirmAction } from "../../lib/confirm";
import { EditOrderSheet } from "./EditOrderSheet";
import {
  dayLabel,
  formatUsd,
  MODALITY_LABEL,
  ORDER_STATUS_LABEL,
  storeLabel,
  windowLabel,
} from "./format";
import { Heading } from "./parts";

/**
 * One order (WS12): what the household said it paid and where, the window, the store's order
 * number and notes, and the lines the store's cart held. The lines come from the run's own record
 * and show the retailer's names, sizes and amounts as that record holds them, for this one store.
 * A person can correct the order, mark it picked up or delivered, or cancel it; cancelling only
 * takes it out of the spend figures, it does not touch the store.
 */
export function OrderDetail({ orderId }: { orderId: string }) {
  const order = useOrder(orderId);
  const lines = useOrderLines(order.data?.run_id);
  const update = useUpdateOrder(orderId);
  const [editing, setEditing] = useState(false);

  if (order.isPending) return <LoadingScreen label="Loading the order" />;
  const data = order.data;
  if (!data) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-white p-6">
        <Text testID="order-missing" className="text-base text-neutral-700">
          This order is not in your household.
        </Text>
      </SafeAreaView>
    );
  }

  const cancelled = data.status === "cancelled";
  const arrived = data.status === "picked_up" || data.status === "delivered";
  const window = windowLabel(data.slot_start, data.slot_end);
  const items = lines.data ?? [];

  return (
    <SafeAreaView className="flex-1 bg-white" edges={["bottom"]}>
      <ScrollView contentContainerClassName="mx-auto w-full max-w-2xl gap-5 px-4 py-4">
        <View testID="order-summary" className="gap-2 rounded-xl bg-neutral-50 p-4">
          <Text accessibilityRole="header" className="text-xl font-bold text-neutral-900">
            {storeLabel(data)}
          </Text>
          <Text
            testID="order-total"
            className={`text-3xl font-bold ${cancelled ? "text-neutral-400 line-through" : "text-neutral-900"}`}
          >
            {formatUsd(data.total_usd)}
          </Text>
          <Text testID="order-status" className="text-base text-neutral-700">
            {ORDER_STATUS_LABEL[data.status]} · {MODALITY_LABEL[data.modality]}
          </Text>
          <Text className="text-sm text-neutral-500">
            Confirmed {dayLabel(data.confirmed_at)}. The total is what you entered.
          </Text>
          {window ? (
            <Text testID="order-window" className="text-sm text-neutral-700">
              {MODALITY_LABEL[data.modality]} window: {window}
            </Text>
          ) : null}
          {data.retailer_order_id ? (
            <Text testID="order-number" className="text-sm text-neutral-700">
              Order number: {data.retailer_order_id}
            </Text>
          ) : null}
          {data.notes ? (
            <Text testID="order-notes" className="text-sm text-neutral-700">
              {data.notes}
            </Text>
          ) : null}
        </View>

        {update.error ? (
          <Text accessibilityRole="alert" className="text-sm text-red-700">
            {orderErrorMessage(update.error)}
          </Text>
        ) : null}

        <View className="gap-2">
          {data.status === "confirmed" ? (
            <Button
              testID="order-arrived"
              label={data.modality === "delivery" ? "Mark as delivered" : "Mark as picked up"}
              loading={update.isPending}
              onPress={() => update.mutate({ status: arrivedStatus(data.modality) })}
            />
          ) : null}
          {arrived || cancelled ? (
            <Button
              testID="order-restore"
              label={cancelled ? "Restore this order" : "Undo"}
              variant="secondary"
              loading={update.isPending}
              onPress={() => update.mutate({ status: "confirmed" })}
            />
          ) : null}
          <Button
            testID="order-edit"
            label="Edit details"
            variant="secondary"
            onPress={() => setEditing(true)}
          />
          {!cancelled ? (
            <Button
              testID="order-cancel"
              label="Cancel this order"
              variant="danger"
              disabled={update.isPending}
              onPress={() =>
                void confirmAction({
                  title: "Cancel this order?",
                  message:
                    "It stops counting toward your spending. This does not cancel anything at the store, so cancel there too if you need to.",
                  confirmLabel: "Cancel order",
                  destructive: true,
                }).then((yes) => {
                  if (yes) update.mutate({ status: "cancelled" });
                })
              }
            />
          ) : null}
        </View>

        <View testID="order-lines" className="gap-3">
          <Heading detail="Prices are the store's, before tax and fees.">
            What was in the cart
          </Heading>
          {lines.isPending ? (
            <Text className="text-sm text-neutral-500">Loading the items</Text>
          ) : null}
          {lines.isError ? (
            <Text accessibilityRole="alert" className="text-sm text-red-700">
              Could not load the items.
            </Text>
          ) : null}
          {!lines.isPending && !lines.isError && items.length === 0 ? (
            <Text testID="order-lines-empty" className="text-sm text-neutral-600">
              The items for this order are no longer stored.
            </Text>
          ) : null}
          {items.map((line) => (
            <View
              key={line.id}
              testID={`order-line-${line.id}`}
              className="min-h-14 flex-row items-center justify-between gap-3 border-b border-neutral-100 py-2"
            >
              <View className="flex-1 gap-0.5">
                <Text className="text-base text-neutral-900">
                  {line.product_name ?? line.display_name}
                </Text>
                {line.size ? <Text className="text-sm text-neutral-500">{line.size}</Text> : null}
                <Text className="text-sm text-neutral-500">
                  {line.unit_price_usd === null
                    ? `Quantity ${line.quantity}`
                    : `${line.quantity} × ${formatPrice(line.unit_price_usd)}`}
                </Text>
              </View>
              {line.line_total_usd === null ? null : (
                <Text className="text-base text-neutral-900">
                  {formatPrice(line.line_total_usd)}
                </Text>
              )}
            </View>
          ))}
        </View>
      </ScrollView>
      <EditOrderSheet order={data} visible={editing} onClose={() => setEditing(false)} />
    </SafeAreaView>
  );
}
