import { StoreModeView } from "../../../src/features/list/StoreModeView";
import { useListTarget } from "../../../src/features/list/useListTarget";

/** In-store mode: big check-off rows in store order, working offline. */
export default function StoreModeScreen() {
  const { weekStart, listId } = useListTarget();
  return <StoreModeView weekStart={weekStart} listId={listId} />;
}
