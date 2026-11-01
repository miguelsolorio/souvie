import { useOrders, useRunForOrder } from "@mp/db";
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { Button } from "../../components/Button";
import { kvStorage } from "../../lib/storage";
import { useShoppingRuns } from "../shopping/useShoppingRun";
import { ConfirmOrderSheet } from "./ConfirmOrderSheet";
import { storeLabel } from "./format";
import { agoLabel, pickPromptRun } from "./logic";
import { dismissRun, readDismissed } from "./promptDismissals";

/**
 * The follow-up to "Did you place this order?" (WS12): two hours after a cart is ready, with no
 * order confirmed, an in-app banner asks again. In-app only: no notification type is added for
 * it. It stops after a week, and "Not now" hides it on this device. Mount it on a screen a person
 * opens when they come back to the app.
 */
export function OrderPromptBanner() {
  const runs = useShoppingRuns();
  const orders = useOrders({ limit: 100 });
  const [dismissed, setDismissed] = useState<string[]>(() => readDismissed(kvStorage));
  const [open, setOpen] = useState(false);

  const orderedRunIds = useMemo(
    () => new Set((orders.data ?? []).map((order) => order.run_id)),
    [orders.data],
  );
  // Until both lists are in, there is nothing to ask about: a run may already have its order.
  const now = new Date();
  const candidate =
    runs.data && orders.data ? pickPromptRun(runs.data, orderedRunIds, dismissed, now) : null;
  const run = useRunForOrder(candidate?.id);

  if (!candidate) return null;
  const store = storeLabel(candidate);

  return (
    <View
      testID="order-banner"
      className="gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4"
    >
      <Text accessibilityRole="header" className="text-base font-semibold text-neutral-900">
        Did you place your {store} order?
      </Text>
      <Text className="text-sm text-neutral-700">
        Your cart was ready {agoLabel(candidate.finished_at ?? candidate.created_at, now)}. Confirm
        it to add it to your history.
      </Text>
      <View className="gap-2">
        <Button
          testID="order-banner-yes"
          label="Yes, I placed it"
          disabled={!run.data}
          onPress={() => setOpen(true)}
        />
        <Button
          testID="order-banner-dismiss"
          label="Not now"
          variant="ghost"
          onPress={() => setDismissed(dismissRun(kvStorage, candidate.id))}
        />
      </View>
      {run.data ? (
        <ConfirmOrderSheet
          runId={candidate.id}
          run={run.data}
          visible={open}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </View>
  );
}
