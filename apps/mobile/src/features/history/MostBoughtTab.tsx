import { canPin, HISTORY_LIMITS, type MostBoughtRow } from "@mp/core";
import { orderErrorMessage, useMostBought, usePinProduct } from "@mp/db";
import { EmptyState } from "@mp/ui/primitives";
import { Pressable, Text, View } from "react-native";
import { storeLabel, timesBoughtLabel } from "./format";
import { Heading, LoadError, Loading, NO_ORDERS_MESSAGE, NO_ORDERS_TITLE } from "./parts";

/**
 * Most bought (WS12): the products on the household's confirmed orders, most first, with a toggle
 * that pins one ("always buy this"). A product's name and size are shown exactly as they were when
 * the household saw them, and no amount is shown here. A line the household typed in by hand has
 * no ingredient to pin the product to, so it has no toggle.
 */
export function MostBoughtTab() {
  const bought = useMostBought();
  const pin = usePinProduct();

  if (bought.isPending) return <Loading label="Loading what you buy most" />;
  if (bought.isError) {
    return (
      <LoadError
        message="Could not load your most bought products."
        onRetry={() => void bought.refetch()}
      />
    );
  }

  const rows = bought.data ?? [];
  if (rows.length === 0) {
    return (
      <EmptyState
        testID="bought-empty"
        icon="🛒"
        title={NO_ORDERS_TITLE}
        message={NO_ORDERS_MESSAGE}
      />
    );
  }

  return (
    <View testID="bought-tab" className="gap-3">
      <Heading detail="Pinned products are chosen first when the shopper buys that ingredient at the same store.">
        {`Your top ${Math.min(rows.length, HISTORY_LIMITS.mostBought)}`}
      </Heading>
      {pin.error ? (
        <Text accessibilityRole="alert" className="text-sm text-red-700">
          {orderErrorMessage(pin.error)}
        </Text>
      ) : null}
      {rows.map((row, index) => (
        <ProductRow
          key={`${row.store_id}:${row.ingredient_id}:${row.product_id}`}
          row={row}
          rank={index + 1}
          busy={pin.isPending}
          onToggle={() => pin.mutate({ row, pinned: !row.pinned })}
        />
      ))}
    </View>
  );
}

function ProductRow({
  row,
  rank,
  busy,
  onToggle,
}: {
  row: MostBoughtRow;
  rank: number;
  busy: boolean;
  onToggle: () => void;
}) {
  const name = row.product_name ?? row.product_id;
  return (
    <View
      testID={`bought-${row.product_id}`}
      className="min-h-16 flex-row items-center gap-3 rounded-xl border border-neutral-200 px-4 py-3"
    >
      <Text className="w-6 text-sm text-neutral-400">{rank}</Text>
      <View className="flex-1 gap-0.5">
        <Text className="text-base text-neutral-900">{name}</Text>
        {row.size ? <Text className="text-sm text-neutral-500">{row.size}</Text> : null}
        <Text className="text-sm text-neutral-600">
          {timesBoughtLabel(row.times_bought)} · {storeLabel(row)}
        </Text>
      </View>
      {canPin(row) ? (
        <Pressable
          testID={`pin-${row.product_id}`}
          accessibilityRole="switch"
          accessibilityState={{ checked: row.pinned, disabled: busy }}
          // react-native-web ignores `accessibilityState.checked`; the aria prop reaches the DOM.
          aria-checked={row.pinned}
          accessibilityLabel={`${row.pinned ? "Unpin" : "Pin"} ${name}`}
          disabled={busy}
          onPress={onToggle}
          className={`min-h-11 min-w-20 items-center justify-center rounded-full border px-4 ${
            row.pinned ? "border-brand bg-brand" : "border-neutral-300 bg-white"
          } ${busy ? "opacity-50" : ""}`}
        >
          <Text
            className={`text-sm font-semibold ${row.pinned ? "text-white" : "text-neutral-900"}`}
          >
            {row.pinned ? "Pinned" : "Pin"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
