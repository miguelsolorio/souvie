// Plan entries for screen tests. Types only come from @mp/db, so a test that uses this can still
// mock that package.
import { groupEntries, type MealSlot } from "@mp/core";
import type { PlanEntry } from "@mp/db";

/** One planned meal. Everything but where it sits and what it is called has a plain default. */
export function planEntry(
  id: string,
  date: string,
  slot: MealSlot,
  title: string,
  over: Partial<PlanEntry> = {},
): PlanEntry {
  return {
    id,
    plan_id: "p1",
    household_id: "h1",
    date,
    slot,
    recipe_id: `r-${id}`,
    servings: 4,
    status: "planned",
    notes: null,
    position: 0,
    created_at: "2026-10-31T12:00:00.000+00:00",
    updated_at: "2026-10-31T12:00:00.000+00:00",
    why: null,
    recipe: {
      id: `r-${id}`,
      title,
      image_url: null,
      servings: 4,
      prep_min: 10,
      cook_min: 20,
      deleted_at: null,
    },
    ...over,
  };
}

/** A week's worth of entries as the planner groups them. */
export const byDay = (entries: PlanEntry[]) => groupEntries(entries);
