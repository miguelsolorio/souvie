import { SegmentedControl } from "@mp/ui/primitives";
import { Pressable, ScrollView, Text, View } from "react-native";
import { TextField } from "../../components/TextField";
import { MODALITY_LABEL } from "./format";
import type { OrderFormErrors, OrderFormState } from "./orderForm";
import { pickupDays } from "./pickupWindow";

/**
 * The fields of the order form, shared by the "Did you place this order?" sheet and the edit
 * sheet: what was paid, pickup or delivery, an optional window, the store's order number and a
 * note. The parent owns the state and the checks (orderForm.ts).
 */
export function OrderFormFields({
  state,
  errors,
  today,
  onChange,
  prefix,
}: {
  state: OrderFormState;
  errors: OrderFormErrors;
  /** The device's calendar date, for the day chips. */
  today: string;
  onChange: (patch: Partial<OrderFormState>) => void;
  /** Prefix for test ids, so two forms on one screen stay apart. */
  prefix: string;
}) {
  const noun = state.modality === "delivery" ? "delivery" : "pickup";
  // A window already on an order can be a past day; keep its chip so the day stays visible.
  const days = pickupDays(today);
  const shown = days.some((day) => day.iso === state.day)
    ? days
    : [{ iso: state.day, label: state.day }, ...days];

  return (
    <View className="gap-4">
      <TextField
        testID={`${prefix}-total`}
        label="What you paid"
        value={state.total}
        onChangeText={(total) => onChange({ total })}
        keyboardType="decimal-pad"
        placeholder="0.00"
        helper="Your total at checkout, with tax and fees. It starts at the cart subtotal."
        error={errors.total ?? null}
      />

      <View className="gap-1.5">
        <Text className="text-sm font-medium text-neutral-800">How you get it</Text>
        <SegmentedControl
          label="How you get it"
          value={state.modality}
          onChange={(modality) => onChange({ modality })}
          options={[
            { value: "pickup", label: MODALITY_LABEL.pickup, testID: `${prefix}-pickup` },
            { value: "delivery", label: MODALITY_LABEL.delivery, testID: `${prefix}-delivery` },
          ]}
        />
      </View>

      <Pressable
        testID={`${prefix}-window-toggle`}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: state.windowOn }}
        accessibilityLabel={`Add a ${noun} window`}
        onPress={() => onChange({ windowOn: !state.windowOn })}
        className="min-h-11 flex-row items-center gap-3"
      >
        <View
          className={`h-6 w-6 items-center justify-center rounded border ${
            state.windowOn ? "border-brand bg-brand" : "border-neutral-400 bg-white"
          }`}
        >
          {state.windowOn ? <Text className="text-sm font-bold text-white">✓</Text> : null}
        </View>
        <Text className="flex-1 text-base text-neutral-900">Add a {noun} window</Text>
      </Pressable>

      {state.windowOn ? (
        <View testID={`${prefix}-window`} className="gap-3">
          <Text className="text-sm text-neutral-500">Optional. Pickup reminders use it.</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View className="flex-row gap-2">
              {shown.map((day) => {
                const selected = day.iso === state.day;
                return (
                  <Pressable
                    key={day.iso}
                    testID={`${prefix}-day-${day.iso}`}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    accessibilityLabel={day.label}
                    onPress={() => onChange({ day: day.iso })}
                    className={`min-h-11 justify-center rounded-full border px-4 ${
                      selected ? "border-brand bg-brand" : "border-neutral-300 bg-white"
                    }`}
                  >
                    <Text
                      className={`text-sm font-medium ${selected ? "text-white" : "text-neutral-900"}`}
                    >
                      {day.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </ScrollView>
          <View className="flex-row gap-3">
            <View className="flex-1">
              <TextField
                testID={`${prefix}-start`}
                label="Starts"
                value={state.start}
                onChangeText={(start) => onChange({ start })}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="4:00 pm"
                error={errors.start ?? null}
              />
            </View>
            <View className="flex-1">
              <TextField
                testID={`${prefix}-end`}
                label="Ends (optional)"
                value={state.end}
                onChangeText={(end) => onChange({ end })}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="5:00 pm"
                error={errors.end ?? null}
              />
            </View>
          </View>
        </View>
      ) : null}

      <TextField
        testID={`${prefix}-order-id`}
        label="Store order number (optional)"
        value={state.retailerOrderId}
        onChangeText={(retailerOrderId) => onChange({ retailerOrderId })}
        autoCapitalize="characters"
        autoCorrect={false}
        error={errors.retailerOrderId ?? null}
      />
      <TextField
        testID={`${prefix}-notes`}
        label="Notes (optional)"
        value={state.notes}
        onChangeText={(notes) => onChange({ notes })}
        error={errors.notes ?? null}
      />
    </View>
  );
}
