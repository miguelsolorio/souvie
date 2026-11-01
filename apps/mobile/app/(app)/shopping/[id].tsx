import { useLocalSearchParams } from "expo-router";
import { OrderPrompt } from "../../../src/features/history/OrderPrompt";
import { RunDetail } from "../../../src/features/shopping/RunDetail";

/**
 * One shopping run (WS09): live progress, review and approve, open the store to pay. WS12 adds
 * "Did you place this order?" through RunDetail's `actions` slot, once the cart is ready.
 */
export default function ShoppingRunScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <RunDetail runId={id} actions={<OrderPrompt runId={id} />} />;
}
