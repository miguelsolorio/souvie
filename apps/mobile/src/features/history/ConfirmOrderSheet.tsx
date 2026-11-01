import { isoDateOf } from "@mp/core";
import { orderErrorMessage, type RunForOrder, useConfirmOrder } from "@mp/db";
import { Sheet } from "@mp/ui/primitives";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "../../components/Button";
import { storeLabel } from "./format";
import { OrderFormFields } from "./OrderFormFields";
import {
  initialForm,
  type OrderFormErrors,
  type OrderFormState,
  toConfirmInput,
  validateForm,
} from "./orderForm";

/**
 * "Did you place this order?" (WS12): the person says they paid in the store's checkout, enters
 * what they paid (it starts at the cart subtotal), and optionally the pickup or delivery window.
 * That is the only thing that makes an order (R19): a cart being ready is not one. The run, the
 * household and the retailer come from the database, and a second confirmation of the same run is
 * refused there, so two taps or two members cannot make two orders.
 */
export function ConfirmOrderSheet({
  runId,
  run,
  visible,
  onClose,
}: {
  runId: string;
  run: RunForOrder;
  visible: boolean;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const confirm = useConfirmOrder(runId);
  const today = isoDateOf(new Date());
  const fresh = () =>
    initialForm({
      subtotal: run.subtotal_usd,
      modality: run.modality,
      today: isoDateOf(new Date()),
    });
  const [form, setForm] = useState<OrderFormState>(fresh);
  const [errors, setErrors] = useState<OrderFormErrors>({});
  const { reset } = confirm;

  // Each time the sheet opens it starts from the run again, with no old error.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only opening resets the form.
  useEffect(() => {
    if (!visible) return;
    setForm(fresh());
    setErrors({});
    reset();
  }, [visible]);

  const submit = () => {
    const result = validateForm(form);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    confirm.mutate(toConfirmInput(result.value), {
      onSuccess: onClose,
      // Someone confirmed it first: the screens refresh and show that order.
      onError: (error) => {
        if (error.code === "already_confirmed") onClose();
      },
    });
  };

  const store = storeLabel(run);
  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Did you place this order?"
      bottomInset={insets.bottom}
      testID="confirm-order-sheet"
    >
      <Text className="text-sm text-neutral-600">
        Confirm only after you paid in {store}'s checkout. Your cart being ready is not an order
        until you say so. This adds the order to your history. It places and changes nothing at the
        store.
      </Text>
      <OrderFormFields
        prefix="confirm"
        state={form}
        errors={errors}
        today={today}
        onChange={(patch) => setForm((current) => ({ ...current, ...patch }))}
      />
      {confirm.error ? (
        <Text
          testID="confirm-order-error"
          accessibilityRole="alert"
          className="text-sm text-red-700"
        >
          {orderErrorMessage(confirm.error)}
        </Text>
      ) : null}
      <View className="gap-2">
        <Button
          testID="confirm-order-submit"
          label="Yes, I placed it"
          loading={confirm.isPending}
          onPress={submit}
        />
        <Button testID="confirm-order-cancel" label="Not yet" variant="ghost" onPress={onClose} />
      </View>
    </Sheet>
  );
}
