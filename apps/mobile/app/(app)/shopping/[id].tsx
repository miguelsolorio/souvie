import { useLocalSearchParams } from "expo-router";
import { RunDetail } from "../../../src/features/shopping/RunDetail";

/** One shopping run (WS09): live progress, review and approve, open the store to pay. */
export default function ShoppingRunScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <RunDetail runId={id} />;
}
