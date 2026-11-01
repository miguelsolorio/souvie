import type { ReviewableItem } from "@mp/agent/review";
import { formatPrice } from "@mp/retailers/kroger/terms";
import { Stepper } from "@mp/ui/primitives";
import { Pressable, Text, View } from "react-native";
import { FLAG_LABEL } from "./LineItemCard";
import type { LineEdit, RunItem } from "./logic";

/**
 * The columns of the run review table (WS13), in pixels and flex weights. The header row and
 * every line use the same ones so the columns line up.
 */
export const CART_COLUMNS = {
  item: "flex-[2]",
  product: "flex-[3]",
  size: "w-24",
  qty: "w-36",
  price: "w-20",
  total: "w-24",
  action: "w-24",
} as const;

/** The header of the run review table. Screen readers hear a table with these six columns. */
export function CartTableHeader() {
  const head = "text-xs font-semibold uppercase tracking-wide text-neutral-500";
  return (
    <View
      role="row"
      testID="cart-table-header"
      className="flex-row items-center gap-3 border-b border-neutral-200 px-3 pb-2"
    >
      <View role="columnheader" className={CART_COLUMNS.item}>
        <Text className={head}>On your list</Text>
      </View>
      <View role="columnheader" className={CART_COLUMNS.product}>
        <Text className={head}>Product</Text>
      </View>
      <View role="columnheader" className={CART_COLUMNS.size}>
        <Text className={head}>Size</Text>
      </View>
      <View role="columnheader" className={CART_COLUMNS.qty}>
        <Text className={head}>Quantity</Text>
      </View>
      <View role="columnheader" className={`${CART_COLUMNS.price} items-end`}>
        <Text className={head}>Price</Text>
      </View>
      <View role="columnheader" className={`${CART_COLUMNS.total} items-end`}>
        <Text className={head}>Line total</Text>
      </View>
      <View role="columnheader" className={`${CART_COLUMNS.action} items-end`}>
        <Text className={head}>Actions</Text>
      </View>
    </View>
  );
}

/**
 * One line of the proposed cart as a table row: what the list asked for, the product the
 * shopper chose, its size, quantity, price and line total, then Remove. A line's flags and its
 * alternatives sit under the row, so a swap is one click away without leaving the table.
 *
 * It takes the same props and calls the same handlers as LineItemCard, so the two layouts
 * cannot drift. Product names, sizes and prices are shown exactly as the store returned them
 * (Kroger terms): nothing is shortened or rounded.
 */
export function LineItemRow({
  item,
  approved,
  edit,
  editable,
  onSwap,
  onRemove,
  onRestore,
  onQuantity,
}: {
  item: RunItem;
  /** The line as it will be approved, with the edit applied. */
  approved: ReviewableItem | undefined;
  edit: LineEdit | undefined;
  editable: boolean;
  onSwap: (alternativeIndex: number) => void;
  onRemove: () => void;
  onRestore: () => void;
  onQuantity: (quantity: number) => void;
}) {
  const shown = approved ?? null;
  const removed =
    edit?.action === "remove" || item.user_decision === "removed" || shown?.status === "removed";
  const name = shown?.productName ?? item.product_name;
  const size = shown?.size ?? item.size;
  const price = shown?.unitPriceUsd ?? item.unit_price_usd;
  const qty = shown?.qty ?? item.qty;
  const total = shown?.lineTotalUsd ?? item.line_total_usd;
  const alternatives = item.alternatives ?? [];
  const swappedTo = edit?.action === "swap" ? edit.alternativeIndex : null;
  const strike = removed ? "text-neutral-400 line-through" : "text-neutral-900";

  return (
    <View
      testID={`run-item-${item.position}`}
      className={`rounded-xl border ${removed ? "border-neutral-200 bg-neutral-50" : "border-neutral-200 bg-white"}`}
    >
      <View role="row" className="min-h-14 flex-row items-center gap-3 px-3 py-2">
        <View role="cell" className={CART_COLUMNS.item}>
          <Text className="text-sm text-neutral-600">{item.display_name}</Text>
        </View>
        <View role="cell" className={CART_COLUMNS.product}>
          {name ? (
            <Text className={`text-base ${strike}`}>{name}</Text>
          ) : (
            <Text className="text-base text-neutral-500">No product chosen</Text>
          )}
        </View>
        <View role="cell" className={CART_COLUMNS.size}>
          {size ? <Text className="text-sm text-neutral-600">{size}</Text> : null}
        </View>
        <View role="cell" className={CART_COLUMNS.qty}>
          {editable && !removed && name && qty !== null ? (
            <Stepper
              testID={`run-item-${item.position}-qty`}
              label={`How many of ${item.display_name}`}
              value={qty}
              min={1}
              max={24}
              onChange={onQuantity}
            />
          ) : name && qty !== null ? (
            <Text className={`text-base ${strike}`}>{qty}</Text>
          ) : null}
        </View>
        <View role="cell" className={`${CART_COLUMNS.price} items-end`}>
          {name && price !== null ? (
            <Text className={`text-base font-semibold ${strike}`}>{formatPrice(price)}</Text>
          ) : null}
        </View>
        <View role="cell" className={`${CART_COLUMNS.total} items-end`}>
          {!removed && name && total !== null ? (
            <Text className="text-base font-semibold text-neutral-900">{formatPrice(total)}</Text>
          ) : null}
        </View>
        <View role="cell" className={`${CART_COLUMNS.action} items-end`}>
          {editable && name ? (
            <Pressable
              testID={`run-item-${item.position}-${removed ? "restore" : "remove"}`}
              accessibilityRole="button"
              accessibilityLabel={`${removed ? "Put back" : "Remove"} ${item.display_name}`}
              onPress={removed ? onRestore : onRemove}
              className="min-h-11 justify-center px-2"
            >
              <Text className={`text-sm font-semibold ${removed ? "text-brand" : "text-red-700"}`}>
                {removed ? "Put back" : "Remove"}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      {item.flags.length > 0 ? (
        <View role="row" className="gap-1 px-3 pb-2">
          <View role="cell" className="gap-1">
            {item.flags.map((flag) => (
              <Text
                key={`${flag.kind}-${flag.detail}`}
                className="rounded-lg bg-amber-50 px-2 py-1 text-sm text-amber-900"
              >
                <Text className="font-semibold">{FLAG_LABEL[flag.kind] ?? "Check"}: </Text>
                {flag.detail}
              </Text>
            ))}
          </View>
        </View>
      ) : null}

      {editable && alternatives.length > 0 ? (
        <View role="row" className="gap-2 px-3 pb-3">
          <View role="cell" className="gap-2">
            <Text className="text-sm font-semibold text-neutral-700">
              {name ? "Or swap to" : "Pick one of these"}
            </Text>
            <View className="flex-row flex-wrap gap-2">
              {alternatives.map((alt, index) => {
                const picked = swappedTo === index;
                return (
                  <Pressable
                    key={alt.product_id}
                    testID={`run-item-${item.position}-alt-${index}`}
                    accessibilityRole="button"
                    accessibilityState={{ selected: picked }}
                    accessibilityLabel={`Swap to ${alt.name}`}
                    onPress={() => onSwap(index)}
                    className={`min-w-56 max-w-80 flex-row items-center justify-between gap-3 rounded-lg border px-3 py-2 ${picked ? "border-brand bg-green-50" : "border-neutral-200"}`}
                  >
                    <View className="flex-1">
                      <Text className="text-sm text-neutral-900">{alt.name}</Text>
                      {alt.size ? (
                        <Text className="text-xs text-neutral-500">{alt.size}</Text>
                      ) : null}
                    </View>
                    {alt.price !== null ? (
                      <Text className="text-sm text-neutral-700">{formatPrice(alt.price)}</Text>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          </View>
        </View>
      ) : null}

      {!editable && item.delta_result && item.delta_result !== "204" ? (
        <View role="row" className="px-3 pb-2">
          <View role="cell">
            <Text className="text-sm text-red-700">Not added to the store cart.</Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}
