import type { EntriesByDay } from "@mp/core";
import type { PlanEntry } from "@mp/db";
import { type ComponentType, useEffect, useState } from "react";

type Live = ComponentType<{ byDay: EntriesByDay<PlanEntry> }>;

/**
 * Mouse and keyboard input for the seven-column week on the web and in the desktop app (WS13):
 * drag a meal onto another slot to move it, and arrow keys to move between days. Render it inside
 * the wide grid; it draws nothing. The phone build uses GridDesktopInput.native.tsx, which does
 * nothing, and the phone layout is unchanged.
 *
 * Moving is `moveEntry`, the same call the entry sheet's Move panel makes, so a drag saves the
 * way every other change does: at once on screen, in the background to the database, and put back
 * with a notice if the save fails (LiveGridInput.tsx).
 *
 * It starts after the first render, in the browser, and loads its working half then. The static
 * export, and a test that renders the grid to markup, draw the grid alone: this is behavior for a
 * live page, not content, and it keeps the grid's own imports light.
 */
export function GridDesktopInput({ byDay }: { byDay: EntriesByDay<PlanEntry> }) {
  const [Live, setLive] = useState<Live | null>(null);

  useEffect(() => {
    let cancelled = false;
    void import("./LiveGridInput").then((module) => {
      if (!cancelled) setLive(() => module.LiveGridInput);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return Live ? <Live byDay={byDay} /> : null;
}
