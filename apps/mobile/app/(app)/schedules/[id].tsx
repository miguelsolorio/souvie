import { useLocalSearchParams } from "expo-router";
import { ScheduleEditorScreen } from "../../../src/features/schedules/ScheduleEditorScreen";

/** /schedules/new makes a schedule; /schedules/<id> edits one. */
export default function ScheduleRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ScheduleEditorScreen scheduleId={id ?? "new"} />;
}
