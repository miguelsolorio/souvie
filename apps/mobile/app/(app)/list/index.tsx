import { useRouter } from "expo-router";
import { ListView } from "../../../src/features/list/ListView";
import { useListTarget } from "../../../src/features/list/useListTarget";

/**
 * The current grocery list: the week the planner was showing (or `?week=`), built from the plan.
 * "Generate list" on the planner lands here.
 */
export default function ListScreen() {
  const router = useRouter();
  const { weekStart, listId } = useListTarget();
  return (
    <ListView
      weekStart={weekStart}
      listId={listId}
      onWeekChange={listId ? undefined : (week) => router.setParams({ week })}
    />
  );
}
