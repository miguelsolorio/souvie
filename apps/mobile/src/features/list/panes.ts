// The sections pane of the two-pane grocery list (WS13). At the desktop breakpoint the list has a
// left pane that names every section and a right pane that shows the items of the chosen one.
// Pure, so it is unit-tested; ListTwoPane.tsx only draws what these functions decide.
import type { GroceryListItem, SectionGroup } from "@mp/core";

/** Every section at once, as on a phone. The pane opens here. */
export const PANE_ALL = "all";
/** The pantry-covered items ("Already have"). */
export const PANE_HAVE = "have";
/** The items a person took off the list ("Removed"). */
export const PANE_REMOVED = "removed";

const SECTION_PREFIX = "section:";

export const sectionPaneKey = (section: string): string => `${SECTION_PREFIX}${section}`;

/** The section a pane key names, or null for "all", "have" and "removed". */
export function sectionOfPane(key: string): string | null {
  return key.startsWith(SECTION_PREFIX) ? key.slice(SECTION_PREFIX.length) : null;
}

export interface PaneEntry {
  key: string;
  label: string;
  /** Items in the pane still to get (not checked off). */
  remaining: number;
  /** Items in the pane. */
  total: number;
}

function remainingOf(items: readonly Pick<GroceryListItem, "checked">[]): number {
  return items.filter((item) => !item.checked).length;
}

/**
 * The left pane, top to bottom: "All items", one entry per store section that has items to buy
 * (in store order, which `groups` already is), then "Already have" and "Removed" when they have
 * anything in them.
 */
export function paneEntries(
  groups: readonly SectionGroup<GroceryListItem>[],
  haveCount: number,
  removedCount: number,
): PaneEntry[] {
  const all = groups.flatMap((group) => group.items);
  const entries: PaneEntry[] = [
    { key: PANE_ALL, label: "All items", remaining: remainingOf(all), total: all.length },
  ];
  for (const group of groups) {
    entries.push({
      key: sectionPaneKey(group.section),
      label: group.label,
      remaining: remainingOf(group.items),
      total: group.items.length,
    });
  }
  if (haveCount > 0) {
    entries.push({ key: PANE_HAVE, label: "Already have", remaining: haveCount, total: haveCount });
  }
  if (removedCount > 0) {
    entries.push({
      key: PANE_REMOVED,
      label: "Removed",
      remaining: removedCount,
      total: removedCount,
    });
  }
  return entries;
}

/**
 * The pane to show. A pane can vanish while it is open (the last "Already have" item goes back on
 * the list), so a key that is no longer in the pane falls back to "All items".
 */
export function resolvePane(entries: readonly PaneEntry[], selected: string): string {
  return entries.some((entry) => entry.key === selected) ? selected : PANE_ALL;
}

/** What a screen reader says for a pane entry: "Produce, 3 of 5 left". */
export function paneAccessibilityLabel(entry: PaneEntry): string {
  if (entry.key === PANE_HAVE || entry.key === PANE_REMOVED) {
    return `${entry.label}, ${entry.total} ${entry.total === 1 ? "item" : "items"}`;
  }
  return `${entry.label}, ${entry.remaining} of ${entry.total} left`;
}
