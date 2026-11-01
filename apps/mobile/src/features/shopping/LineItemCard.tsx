import type { ReviewableItem } from "@mp/agent/review";
import { formatPrice } from "@mp/retailers/kroger/terms";
import { Stepper } from "@mp/ui/primitives";
import { Pressable, Text, View } from "react-native";
import type { LineEdit, RunItem } from "./logic";

/** The flags a line can carry, in a few words for the chip. */
export const FLAG_LABEL: Record<string, string> = {
  allergen: "Allergy",
  allergen_may_contain: "Check the label",
  allergen_data_missing: "Check the label",
  allergen_unknown: "Check the label",
  over_item_ceiling: "Over your item limit",
  substitution: "Different brand",
  qualifier: "No exact match",
  needs_attention: "Check the match",
  low_confidence: "Check the match",
  out_of_stock: "Out of stock",
  pinned_unavailable: "Usual pick unavailable",
  unmatched: "Not found",
  quota: "Not searched",
  model_unavailable: "Check the match",
  limit_reached: "Check the match",
  cart_rejected: "Not added",
  unavailable: "No longer offered",
};

/**
 * One line of the proposed cart: what the list asked for, the product the shopper chose, its price,
 * and up to three alternatives. Product names, sizes and prices are shown exactly as the store
 * returned them (Kroger terms): nothing is shortened or rounded.
 */
export function LineItemCard({
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

  return (
    <View
      testID={`run-item-${item.position}`}
      className={`gap-3 rounded-xl border p-3 ${removed ? "border-neutral-200 bg-neutral-50" : "border-neutral-200 bg-white"}`}
    >
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1 gap-1">
          <Text className="text-sm text-neutral-500">{item.display_name}</Text>
          {name ? (
            <Text
              className={`text-base ${removed ? "text-neutral-400 line-through" : "text-neutral-900"}`}
            >
              {name}
            </Text>
          ) : (
            <Text className="text-base text-neutral-500">No product chosen</Text>
          )}
          {size ? <Text className="text-sm text-neutral-600">{size}</Text> : null}
        </View>
        {name && price !== null ? (
          <View className="items-end">
            <Text className="text-base font-semibold text-neutral-900">{formatPrice(price)}</Text>
            {!removed && qty !== null && qty > 1 && total !== null ? (
              <Text className="text-xs text-neutral-500">
                {qty} for {formatPrice(total)}
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>

      {item.flags.length > 0 ? (
        <View className="gap-1">
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
      ) : null}

      {editable && !removed && name && qty !== null ? (
        <Stepper
          testID={`run-item-${item.position}-qty`}
          label={`How many of ${item.display_name}`}
          value={qty}
          min={1}
          max={24}
          onChange={onQuantity}
        />
      ) : null}

      {editable && alternatives.length > 0 ? (
        <View className="gap-2">
          <Text className="text-sm font-semibold text-neutral-700">
            {name ? "Or swap to" : "Pick one of these"}
          </Text>
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
                className={`flex-row items-center justify-between gap-3 rounded-lg border px-3 py-2 ${picked ? "border-brand bg-green-50" : "border-neutral-200"}`}
              >
                <View className="flex-1">
                  <Text className="text-sm text-neutral-900">{alt.name}</Text>
                  {alt.size ? <Text className="text-xs text-neutral-500">{alt.size}</Text> : null}
                </View>
                {alt.price !== null ? (
                  <Text className="text-sm text-neutral-700">{formatPrice(alt.price)}</Text>
                ) : null}
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {editable && name ? (
        <View className="flex-row justify-end">
          <Pressable
            testID={`run-item-${item.position}-${removed ? "restore" : "remove"}`}
            accessibilityRole="button"
            onPress={removed ? onRestore : onRemove}
            className="min-h-11 justify-center px-2"
          >
            <Text className={`text-sm font-semibold ${removed ? "text-brand" : "text-red-700"}`}>
              {removed ? "Put back" : "Remove"}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {!editable && item.delta_result && item.delta_result !== "204" ? (
        <Text className="text-sm text-red-700">Not added to the store cart.</Text>
      ) : null}
    </View>
  );
}
