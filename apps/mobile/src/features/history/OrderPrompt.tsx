import { useRunForOrder, useRunOrder } from "@mp/db";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Text, View } from "react-native";
import { Button } from "../../components/Button";
import { ConfirmOrderSheet } from "./ConfirmOrderSheet";
import { formatUsd, MODALITY_LABEL, ORDER_STATUS_LABEL, storeLabel, windowLabel } from "./format";
import { canConfirm } from "./logic";
import { orderRoute } from "./routes";

/**
 * What a run's screen says about its order (WS12), mounted through RunDetail's `actions` slot. It
 * fetches the run itself: the slot passes it nothing.
 *
 *   - the cart is ready (or checked out) and nobody confirmed an order: "Did you place this
 *     order?", which opens the confirmation sheet. A ready cart is not an order (R19), so the
 *     wording asks and never says "placed".
 *   - an order exists: its total and window, and a way to open it.
 *   - anything else (still shopping, failed, cancelled): nothing.
 */
export function OrderPrompt({ runId }: { runId: string }) {
  const router = useRouter();
  const run = useRunForOrder(runId);
  const order = useRunOrder(runId);
  const [open, setOpen] = useState(false);

  // Not knowing whether an order exists is not a reason to ask: stay quiet until it is known.
  if (run.isPending || order.isPending || order.isError) return null;
  const data = run.data;
  if (!data) return null;

  const existing = order.data;
  if (existing) {
    const window = windowLabel(existing.slot_start, existing.slot_end);
    return (
      <View testID="order-confirmed" className="gap-2 rounded-xl border border-neutral-200 p-4">
        <Text accessibilityRole="header" className="text-lg font-semibold text-neutral-900">
          {existing.status === "cancelled" ? "Order cancelled" : "Order confirmed"}
        </Text>
        <Text testID="order-confirmed-summary" className="text-base text-neutral-800">
          {formatUsd(existing.total_usd)} · {MODALITY_LABEL[existing.modality]} ·{" "}
          {ORDER_STATUS_LABEL[existing.status]}
        </Text>
        {window ? <Text className="text-sm text-neutral-600">{window}</Text> : null}
        <Button
          testID="order-confirmed-open"
          label="View order"
          variant="secondary"
          onPress={() => router.push(orderRoute(existing.id))}
        />
      </View>
    );
  }

  if (!canConfirm(data)) return null;

  return (
    <View
      testID="order-prompt"
      className="gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4"
    >
      <Text accessibilityRole="header" className="text-lg font-semibold text-neutral-900">
        Did you place this order?
      </Text>
      <Text className="text-sm text-neutral-700">
        After you pay in {storeLabel(data)}'s checkout, confirm it here so it shows in your history.
        A ready cart is not an order until you say so.
      </Text>
      <Button testID="order-prompt-yes" label="Yes, I placed it" onPress={() => setOpen(true)} />
      <ConfirmOrderSheet runId={runId} run={data} visible={open} onClose={() => setOpen(false)} />
    </View>
  );
}
