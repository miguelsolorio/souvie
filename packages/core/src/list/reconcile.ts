// Rebuilding a list without losing what people did to it (WS05, acceptance criterion 4).
//
// A rebuild computes a fresh draft from the plan and has to fold it into the rows already on the
// list. `reconcileItems` decides, for every draft item, whether it updates an existing row (same
// ingredient and qualifiers) or is new, and which existing rows go. The rules:
//
//   * a manual item (typed in by hand) is never touched and never removed
//   * a matched row keeps its id, so a Realtime update reaches the other phones as an update, and
//     keeps checked, checked_by and checked_at: the draft never writes them
//   * a row a person edited (quantity, unit, section) keeps those edits; the rest is refreshed
//   * a row a person removed from the list (excluded_reason = 'manual') stays removed
//   * an automatic row with no counterpart in the draft is deleted: nobody needs it any more
//   * a draft item with no row is inserted unchecked
//
// Pure, so the rules are tested here and `list-build` only has to run the statements.
import { type DraftItem, type ExcludedReason, type ItemDetail, itemDetailOf } from "./types.ts";

/** The columns of an existing row the rules read. */
export interface ExistingListItem {
  id: string;
  ingredient_id: string | null;
  display_name: string;
  qualifiers: readonly string[];
  qty: number | null;
  unit: string | null;
  section: string;
  excluded_reason: ExcludedReason | null;
  is_manual: boolean;
  edited: boolean;
  position: number;
}

/** The columns `list-build` writes for an automatic item. Checked state is never among them. */
export interface ItemWrite {
  ingredient_id: string | null;
  display_name: string;
  qty: number | null;
  unit: string | null;
  source_entry_ids: string[];
  section: string;
  qualifiers: string[];
  detail: ItemDetail;
  excluded_reason: ExcludedReason | null;
  needs_attention: boolean;
  position: number;
  edited: boolean;
}

export interface ReconcileResult {
  inserts: ItemWrite[];
  updates: Array<{ id: string; write: ItemWrite }>;
  deletes: string[];
}

/** What makes two items "the same line of the list": the ingredient and what was asked of it. */
export function itemMatchKey(item: {
  ingredientId: string | null;
  displayName: string;
  qualifiers: readonly string[];
}): string {
  if (item.ingredientId) return `i:${item.ingredientId}:${[...item.qualifiers].sort().join(",")}`;
  // Unparsed lines have no ingredient; the raw text they are named by is all there is.
  return `r:${item.displayName.trim().toLowerCase()}`;
}

function existingKey(row: ExistingListItem): string {
  return itemMatchKey({
    ingredientId: row.ingredient_id,
    displayName: row.display_name,
    qualifiers: row.qualifiers,
  });
}

function writeFor(item: DraftItem, keep?: ExistingListItem): ItemWrite {
  const edited = keep?.edited === true;
  return {
    ingredient_id: item.ingredientId,
    display_name: item.displayName,
    // An edit is the person's answer; the contributions behind the number still refresh.
    qty: edited && keep ? keep.qty : item.qty,
    unit: edited && keep ? keep.unit : item.unit,
    section: edited && keep ? keep.section : item.section,
    source_entry_ids: item.sourceEntryIds,
    qualifiers: item.qualifiers,
    detail: itemDetailOf(item),
    // A person who took an item off the list keeps it off, whatever the pantry now says.
    excluded_reason: keep?.excluded_reason === "manual" ? "manual" : (item.excludedReason ?? null),
    needs_attention: item.needsAttention,
    position: item.position,
    edited,
  };
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const list = groups.get(key);
    if (list) list.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

/**
 * Folds a fresh draft into the rows a list already has. Existing rows are matched to draft items
 * by ingredient and qualifiers; when several rows share a key (an ingredient that could not be
 * added in one unit) they are paired by unit first, then in order.
 */
export function reconcileItems(
  existing: readonly ExistingListItem[],
  draft: readonly DraftItem[],
): ReconcileResult {
  const result: ReconcileResult = { inserts: [], updates: [], deletes: [] };
  const rows = groupBy(
    existing.filter((row) => !row.is_manual),
    existingKey,
  );
  const items = groupBy(draft, itemMatchKey);

  for (const [key, group] of items) {
    const candidates = [...(rows.get(key) ?? [])].sort(
      (a, b) => a.position - b.position || a.id.localeCompare(b.id),
    );
    const unpaired: DraftItem[] = [];
    for (const item of group) {
      const index = candidates.findIndex((row) => row.unit === item.unit);
      const row = index === -1 ? undefined : candidates.splice(index, 1)[0];
      if (row) result.updates.push({ id: row.id, write: writeFor(item, row) });
      else unpaired.push(item);
    }
    for (const item of unpaired) {
      const row = candidates.shift();
      if (row) result.updates.push({ id: row.id, write: writeFor(item, row) });
      else result.inserts.push(writeFor(item));
    }
    rows.set(key, candidates);
  }

  for (const leftover of rows.values()) {
    for (const row of leftover) result.deletes.push(row.id);
  }
  return result;
}
