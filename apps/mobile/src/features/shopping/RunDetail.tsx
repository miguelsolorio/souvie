import { formatPrice } from "@mp/retailers/kroger/terms";
import * as Linking from "expo-linking";
import { type ReactNode, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../components/Button";
import { LoadingScreen } from "../../components/Screen";
import { confirmAction } from "../../lib/confirm";
import {
  isActive,
  overBudget,
  preview,
  progressText,
  type ReviewDraft,
  STATUS_LABEL,
} from "./logic";
import { ProposedCart } from "./ProposedCart";
import { TranscriptView } from "./TranscriptView";
import { useRunRealtime } from "./useRunRealtime";
import { useApproveRun, useCancelRun, useRunItems, useShoppingRun } from "./useShoppingRun";

/** Where Tier 1 ends when the snapshot has expired: the retailer's own checkout. */
const CHECKOUT_FALLBACK: Readonly<Record<string, string>> = {
  kroger: "https://www.kroger.com/checkout",
};

/**
 * One shopping run: live status, the proposed cart to review and approve, "Open store to pay"
 * once the cart is filled, the transcript, and cancel. `actions` renders below the cart summary,
 * so WS12 can mount its "I placed it" sheet here without editing this file.
 */
export function RunDetail({ runId, actions }: { runId: string; actions?: ReactNode }) {
  useRunRealtime();
  const run = useShoppingRun(runId);
  const items = useRunItems(runId);
  const approve = useApproveRun(runId);
  const cancel = useCancelRun(runId);
  const [draft, setDraft] = useState<ReviewDraft>({});
  const [showTranscript, setShowTranscript] = useState(false);

  const lines = items.data ?? [];
  const review = useMemo(() => preview(lines, draft), [lines, draft]);

  if (run.isPending) return <LoadingScreen label="Loading the run" />;
  const data = run.data;
  if (!data) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-white p-6">
        <Text className="text-base text-neutral-700">This run is not in your household.</Text>
      </SafeAreaView>
    );
  }

  const snapshot = data.cart_snapshot ?? {};
  const reviewing = data.status === "needs_review";
  const working =
    data.status === "queued" || data.status === "running" || data.status === "checking_out";
  const cap = reviewing ? overBudget(review.subtotalUsd, data.policy) : null;
  const subtotal = reviewing
    ? review.subtotalUsd
    : (data.subtotal_usd ?? snapshot.subtotalUsd ?? 0);
  const handoff = snapshot.handoffUrl ?? CHECKOUT_FALLBACK[data.retailer] ?? null;
  const store = data.store_name ?? snapshot.storeName ?? "your store";

  return (
    <SafeAreaView className="flex-1 bg-white" edges={["bottom"]}>
      <ScrollView contentContainerClassName="mx-auto w-full max-w-2xl gap-5 px-4 py-4">
        <View testID="run-status" className="gap-2 rounded-xl bg-neutral-50 p-4">
          <View className="flex-row items-center gap-2">
            {working ? <ActivityIndicator color="#2F6B4F" /> : null}
            <Text accessibilityRole="header" className="text-xl font-bold text-neutral-900">
              {STATUS_LABEL[data.status]}
            </Text>
          </View>
          <Text testID="run-progress" className="text-base text-neutral-700">
            {progressText(data)}
          </Text>
          <Text className="text-sm text-neutral-500">{store}</Text>
        </View>

        {snapshot.summary && (reviewing || data.status === "cart_ready") ? (
          <Text testID="run-summary" className="text-base text-neutral-800">
            {snapshot.summary}
          </Text>
        ) : null}

        {(snapshot.flags ?? []).map((flag) => (
          <Text
            key={`${flag.kind}-${flag.detail}`}
            className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900"
          >
            {flag.detail}
          </Text>
        ))}

        {lines.length > 0 ? (
          <View className="gap-1">
            <Text testID="run-subtotal" className="text-lg font-semibold text-neutral-900">
              {review.cartLines} items, {formatPrice(subtotal)}
            </Text>
            <Text className="text-sm text-neutral-500">
              Prices are the store's, before tax and fees. The store confirms them at checkout.
            </Text>
          </View>
        ) : null}

        {actions}

        {reviewing ? (
          <View className="gap-2">
            {cap !== null ? (
              <Text accessibilityRole="alert" className="text-sm text-red-700">
                This cart is over your {formatPrice(cap)} budget. Remove items or lower quantities
                to approve it.
              </Text>
            ) : null}
            {approve.error ? (
              <Text accessibilityRole="alert" className="text-sm text-red-700">
                {approve.error.message}
              </Text>
            ) : null}
            <Button
              testID="run-approve"
              label="Approve and fill cart"
              loading={approve.isPending}
              disabled={cap !== null || review.cartLines === 0 || review.errors.length > 0}
              onPress={() =>
                approve.mutate({ items: lines, draft }, { onSuccess: () => setDraft({}) })
              }
            />
          </View>
        ) : null}

        {data.status === "cart_ready" && handoff ? (
          <View className="gap-2">
            <Button
              testID="run-open-store"
              label="Open store to pay"
              onPress={() => void Linking.openURL(handoff)}
            />
            <Text className="text-sm text-neutral-500">
              Pick a pickup time and pay in {store}'s checkout. The cart there holds what you
              approved.
            </Text>
          </View>
        ) : null}

        {items.isPending && lines.length === 0 && !working ? (
          <ActivityIndicator color="#2F6B4F" />
        ) : null}
        {lines.length > 0 ? (
          <ProposedCart
            items={lines}
            draft={draft}
            preview={review}
            editable={reviewing}
            onDraft={setDraft}
          />
        ) : null}

        <View className="gap-3 border-t border-neutral-200 pt-4">
          <Pressable
            testID="run-transcript-toggle"
            accessibilityRole="button"
            onPress={() => setShowTranscript((open) => !open)}
            className="min-h-11 justify-center"
          >
            <Text className="text-base font-semibold text-brand">
              {showTranscript ? "Hide the steps" : "Show every step"}
            </Text>
          </Pressable>
          {showTranscript ? <TranscriptView entries={data.transcript} /> : null}
          {isActive(data.status) ? (
            <Button
              testID="run-cancel"
              label="Cancel this run"
              variant="danger"
              loading={cancel.isPending}
              onPress={() =>
                void confirmAction({
                  title: "Cancel this run?",
                  message:
                    data.status === "cart_ready"
                      ? "Items already in your store cart stay there."
                      : "Nothing more will be added to your store cart.",
                  confirmLabel: "Cancel run",
                }).then((yes) => {
                  if (yes) cancel.mutate();
                })
              }
            />
          ) : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
