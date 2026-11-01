import { HISTORY_LIMITS, isoDateOf, weekStartFor } from "@mp/core";
import { useOrders, useSpendWeekly } from "@mp/db";
import { EmptyState } from "@mp/ui/primitives";
import { useRouter } from "expo-router";
import { Pressable, Text, View } from "react-native";
import { relativeWeekLabel, weekRangeLabel } from "../plan/format";
import {
  dayLabel,
  formatUsd,
  MODALITY_LABEL,
  ORDER_STATUS_LABEL,
  orderCountLabel,
  storeLabel,
} from "./format";
import { groupSpend, spendForWeek, totalSpend } from "./logic";
import { Heading, LoadError, Loading, NO_ORDERS_MESSAGE, NO_ORDERS_TITLE, Stat } from "./parts";
import { orderRoute } from "./routes";

/**
 * Spend, per week and per store (WS12): the sum of the order totals the household confirmed, as a
 * plain bar list, then the recent orders. These are the household's own totals, never a product
 * price. Stores do not share order history, so every figure here is one a person confirmed.
 */
export function SpendTab() {
  const router = useRouter();
  const spend = useSpendWeekly();
  const orders = useOrders({ limit: 30 });
  const today = isoDateOf(new Date());

  if (spend.isPending || orders.isPending) return <Loading label="Loading your spending" />;
  if (spend.isError || orders.isError) {
    return (
      <LoadError
        message="Could not load your spending."
        onRetry={() => {
          void spend.refetch();
          void orders.refetch();
        }}
      />
    );
  }

  const rows = spend.data ?? [];
  const recent = orders.data ?? [];
  if (rows.length === 0 && recent.length === 0) {
    return (
      <EmptyState
        testID="spend-empty"
        icon="🧾"
        title={NO_ORDERS_TITLE}
        message={NO_ORDERS_MESSAGE}
      />
    );
  }

  const thisWeek = weekStartFor(today);
  const weeks = groupSpend(rows);
  return (
    <View testID="spend-tab" className="gap-5">
      <View className="flex-row gap-3">
        <Stat
          testID="spend-this-week"
          value={formatUsd(spendForWeek(rows, thisWeek))}
          label="Spent this week"
        />
        <Stat
          testID="spend-total"
          value={formatUsd(totalSpend(rows))}
          label={`Last ${HISTORY_LIMITS.weeks} weeks`}
        />
      </View>

      {weeks.map((week) => (
        <View key={week.weekStart} testID={`spend-week-${week.weekStart}`} className="gap-3">
          <Heading detail={`${weekRangeLabel(week.weekStart)} · ${orderCountLabel(week.orders)}`}>
            {`${relativeWeekLabel(week.weekStart, thisWeek)}: ${formatUsd(week.total)}`}
          </Heading>
          {week.stores.map((store) => (
            <View
              key={store.key}
              testID={`spend-${week.weekStart}-${store.key}`}
              accessible
              accessibilityLabel={`${store.label}, ${formatUsd(store.total)}, ${orderCountLabel(store.orders)}`}
              className="gap-1.5"
            >
              <View className="flex-row items-baseline justify-between gap-3">
                <Text className="flex-1 text-base text-neutral-900">{store.label}</Text>
                <Text className="text-base font-semibold text-neutral-900">
                  {formatUsd(store.total)}
                </Text>
              </View>
              <View className="h-2 overflow-hidden rounded-full bg-neutral-100">
                <View
                  className="h-2 rounded-full bg-brand"
                  style={{ width: `${Math.max(2, Math.round(store.share * 100))}%` }}
                />
              </View>
              <Text className="text-xs text-neutral-500">{orderCountLabel(store.orders)}</Text>
            </View>
          ))}
        </View>
      ))}

      {recent.length > 0 ? (
        <View testID="spend-orders" className="gap-2">
          <Heading detail="Tap an order to see what was in it.">Orders</Heading>
          {recent.map((order) => {
            const cancelled = order.status === "cancelled";
            return (
              <Pressable
                key={order.id}
                testID={`order-row-${order.id}`}
                accessibilityRole="button"
                accessibilityLabel={`${storeLabel(order)}, ${dayLabel(order.confirmed_at)}, ${formatUsd(order.total_usd)}, ${ORDER_STATUS_LABEL[order.status]}`}
                onPress={() => router.push(orderRoute(order.id))}
                className="min-h-14 flex-row items-center justify-between gap-3 rounded-xl border border-neutral-200 px-4 py-3"
              >
                <View className="flex-1 gap-0.5">
                  <Text
                    className={`text-base ${cancelled ? "text-neutral-400 line-through" : "text-neutral-900"}`}
                  >
                    {storeLabel(order)}
                  </Text>
                  <Text className="text-sm text-neutral-500">
                    {dayLabel(order.confirmed_at)} · {MODALITY_LABEL[order.modality]} ·{" "}
                    {ORDER_STATUS_LABEL[order.status]}
                  </Text>
                </View>
                <Text
                  className={`text-base font-semibold ${cancelled ? "text-neutral-400" : "text-neutral-900"}`}
                >
                  {formatUsd(order.total_usd)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      <Text className="text-xs text-neutral-500">
        Totals are what you entered when you confirmed each order. Cancelled orders are left out of
        the bars. Weeks run Monday to Sunday.
      </Text>
    </View>
  );
}
