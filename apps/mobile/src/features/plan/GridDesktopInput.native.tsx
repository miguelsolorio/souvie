import type { EntriesByDay } from "@mp/core";
import type { PlanEntry } from "@mp/db";

/**
 * Drag to move and arrow-key navigation are for a mouse and a keyboard, so on iOS and Android the
 * wide week grid (an iPad in landscape) has none of it: meals move through the entry sheet, as
 * they do on a phone. The web version is GridDesktopInput.tsx.
 */
export function GridDesktopInput(_props: { byDay: EntriesByDay<PlanEntry> }) {
  return null;
}
