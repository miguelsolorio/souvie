import { isoDateOf } from "@mp/core";
import { type OrderWithStore, orderErrorMessage, useUpdateOrder } from "@mp/db";
import { Sheet } from "@mp/ui/primitives";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "../../components/Button";
import { OrderFormFields } from "./OrderFormFields";
import {
  formFromOrder,
  type OrderFormErrors,
  type OrderFormState,
  toOrderPatch,
  validateForm,
} from "./orderForm";

/** Corrects an order after the fact: the total, the window, the order number, the notes. */
export function EditOrderSheet({
  order,
  visible,
  onClose,
}: {
  order: OrderWithStore;
  visible: boolean;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const update = useUpdateOrder(order.id);
  const today = isoDateOf(new Date());
  const fresh = () => formFromOrder(order, isoDateOf(new Date()));
  const [form, setForm] = useState<OrderFormState>(fresh);
  const [errors, setErrors] = useState<OrderFormErrors>({});
  const { reset } = update;

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
    update.mutate(toOrderPatch(result.value), { onSuccess: onClose });
  };

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Edit order"
      bottomInset={insets.bottom}
      testID="edit-order-sheet"
    >
      <OrderFormFields
        prefix="edit"
        state={form}
        errors={errors}
        today={today}
        onChange={(patch) => setForm((current) => ({ ...current, ...patch }))}
      />
      {update.error ? (
        <Text accessibilityRole="alert" className="text-sm text-red-700">
          {orderErrorMessage(update.error)}
        </Text>
      ) : null}
      <View className="gap-2">
        <Button
          testID="edit-order-save"
          label="Save changes"
          loading={update.isPending}
          onPress={submit}
        />
        <Button testID="edit-order-cancel" label="Cancel" variant="ghost" onPress={onClose} />
      </View>
    </Sheet>
  );
}
