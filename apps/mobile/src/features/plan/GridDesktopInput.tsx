import type { EntriesByDay } from "@mp/core";
import { type PlanEntry, useHousehold } from "@mp/db";
import { type ComponentRef, useEffect, useMemo, useRef } from "react";
import { View } from "react-native";
import { attachGridInput } from "./gridInput";
import { usePlanActions } from "./usePlanActions";

/**
 * Mouse and keyboard input for the seven-column week on the web and in the desktop app (WS13):
 * drag a meal onto another slot to move it, and arrow keys to move between days. Render it inside
 * the wide grid; it draws nothing. The phone build uses GridDesktopInput.native.tsx, which does
 * nothing, and the phone layout is unchanged.
 *
 * Moving is `moveEntry`, the same call the entry sheet's Move panel makes, so a drag saves the
 * way every other change does: at once on screen, in the background to the database, and put back
 * with a notice if the save fails.
 */
export function GridDesktopInput({ byDay }: { byDay: EntriesByDay<PlanEntry> }) {
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
