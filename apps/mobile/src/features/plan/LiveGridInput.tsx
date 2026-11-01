import type { EntriesByDay } from "@mp/core";
import { type PlanEntry, useHousehold } from "@mp/db";
import { type ComponentRef, useEffect, useMemo, useRef } from "react";
import { View } from "react-native";
import { attachGridInput } from "./gridInput";
import { usePlanActions } from "./usePlanActions";

/**
 * The working half of GridDesktopInput: it reads the household and the plan's actions, finds the
 * week grid around it in the page, and wires drag to move and the arrow keys onto it
 * (gridInput.ts). It draws a zero-size marker, which is how it finds the grid.
 */
export function LiveGridInput({ byDay }: { byDay: EntriesByDay<PlanEntry> }) {
  const household = useHousehold();
  const actions = usePlanActions(household.data?.id);
  const entries = useMemo(
    () => Object.values(byDay).flatMap((day) => Object.values(day).flat()),
    [byDay],
  );

  // The listeners are attached once; they read the latest entries and actions through this ref.
  const latest = useRef({ entries, actions });
  latest.current = { entries, actions };

  const marker = useRef<ComponentRef<typeof View>>(null);
  useEffect(() => {
    const node = marker.current as unknown as HTMLElement | null;
    const root = (node?.closest('[data-testid="week-grid"]') ?? null) as HTMLElement | null;
    if (!root) return;
    return attachGridInput(root, {
      onMove: (entryId, target) => {
        const { entries: current, actions: act } = latest.current;
        const entry = current.find((candidate) => candidate.id === entryId);
        if (entry) act.moveEntry(entry, target, current);
      },
    });
  }, []);

  return (
    <View
      ref={marker}
      accessibilityElementsHidden
      style={{ position: "absolute", width: 0, height: 0, pointerEvents: "none" }}
    />
  );
}
