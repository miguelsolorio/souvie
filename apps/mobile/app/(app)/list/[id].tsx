import { isoDateOf, weekStartFor } from "@mp/core";
import { useLocalSearchParams } from "expo-router";
import { ListView } from "../../../src/features/list/ListView";

/** One grocery list by id, for a link to a list that is not this week's. */
export default function ListByIdScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ListView weekStart={weekStartFor(isoDateOf(new Date()))} listId={id ?? null} />;
}
