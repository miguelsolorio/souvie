import { useLocalSearchParams } from "expo-router";
import { OrderDetail } from "../../../../src/features/history/OrderDetail";

/** One confirmed order (WS12): its total, window, and the items in the cart. */
export default function OrderRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <OrderDetail orderId={id} />;
}
