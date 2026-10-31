import { useRouter } from "expo-router";
import { ListView } from "../../../src/features/list/ListView";
import { useListTarget } from "../../../src/features/list/useListTarget";

/**
 * The current grocery list: the week the planner was showing (or `?week=`), built from the plan.
 * "Generate list" on the planner lands here.
 */
export default function ListScreen() {
  const router = useRouter();
  const { weekStart, listId, autoBuild } = useListTarget();
  return (
    <ListView
      weekStart={weekStart}
      listId={listId}
      autoBuild={autoBuild && !listId}
      // Moving to another week drops the build request: it was for the week the planner showed.
      onWeekChange={listId ? undefined : (week) => router.setParams({ week, build: undefined })}
      onAutoBuildStarted={() => router.setParams({ build: undefined })}
    />
  );
}
