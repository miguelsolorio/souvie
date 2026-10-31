import { describe, expect, it } from "vitest";
import { buildList } from "./aggregate.ts";
import { type ListFixture, runFixture } from "./fixtures/harness.ts";
import { FIXTURES } from "./fixtures/index.ts";
import { type ExistingListItem, itemMatchKey, reconcileItems } from "./reconcile.ts";
import type { DraftItem } from "./types.ts";

const ID = (n: number) => `99999999-0000-4000-8000-${String(n).padStart(12, "0")}`;

function draftItem(overrides: Partial<DraftItem>): DraftItem {
  return {
    ingredientId: "i1",
    displayName: "Thing",
    qty: 1,
    unit: "each",
    sourceEntryIds: [],
    section: "produce",
    qualifiers: [],
    contributions: [],
    needsAttention: false,
    position: 0,
    ...overrides,
  };
}

function row(overrides: Partial<ExistingListItem>): ExistingListItem {
  return {
    id: ID(1),
    ingredient_id: "i1",
    display_name: "Thing",
    qualifiers: [],
    qty: 1,
    unit: "each",
    section: "produce",
    excluded_reason: null,
    is_manual: false,
    edited: false,
    position: 0,
    ...overrides,
  };
}

describe("reconcileItems", () => {
  it("updates a row for the same ingredient and never writes its checked state", () => {
    const result = reconcileItems([row({ id: ID(1) })], [draftItem({ qty: 3 })]);
    expect(result.inserts).toEqual([]);
    expect(result.deletes).toEqual([]);
    expect(result.updates).toHaveLength(1);
    expect(result.updates[0]?.id).toBe(ID(1));
    expect(result.updates[0]?.write.qty).toBe(3);
    const columns = Object.keys(result.updates[0]?.write ?? {});
    for (const forbidden of ["checked", "checked_by", "checked_at", "id", "list_id", "is_manual"]) {
      expect(columns).not.toContain(forbidden);
    }
  });

  it("inserts a new ingredient and deletes one that left the plan", () => {
    const result = reconcileItems(
      [row({ id: ID(1), ingredient_id: "gone", display_name: "Gone" })],
      [draftItem({ ingredientId: "new", displayName: "New" })],
    );
    expect(result.inserts).toHaveLength(1);
    expect(result.inserts[0]?.ingredient_id).toBe("new");
    expect(result.deletes).toEqual([ID(1)]);
    expect(result.updates).toEqual([]);
  });

  it("leaves manual items alone: never updated, never deleted", () => {
    const manual = row({
      id: ID(7),
      ingredient_id: null,
      display_name: "Paper towels",
      is_manual: true,
    });
    const result = reconcileItems([manual], []);
    expect(result).toEqual({ inserts: [], updates: [], deletes: [] });
    // Even a draft item with the same name does not claim a manual row.
    const same = reconcileItems(
      [manual],
      [draftItem({ ingredientId: null, displayName: "Paper towels" })],
    );
    expect(same.updates).toEqual([]);
    expect(same.deletes).toEqual([]);
    expect(same.inserts).toHaveLength(1);
  });

  it("keeps a person's edits to quantity, unit and section", () => {
    const edited = row({ qty: 5, unit: "lb", section: "meat", edited: true });
    const result = reconcileItems(
      [edited],
      [draftItem({ qty: 2, unit: "each", section: "produce" })],
    );
    expect(result.updates[0]?.write).toMatchObject({
      qty: 5,
      unit: "lb",
      section: "meat",
      edited: true,
    });
  });

  it("refreshes an unedited row's amounts and keeps edited false", () => {
    const result = reconcileItems([row({ qty: 5 })], [draftItem({ qty: 2 })]);
    expect(result.updates[0]?.write).toMatchObject({ qty: 2, edited: false });
  });

  it("keeps a removed item removed, but follows the pantry otherwise", () => {
    const removed = reconcileItems([row({ excluded_reason: "manual" })], [draftItem({})]);
    expect(removed.updates[0]?.write.excluded_reason).toBe("manual");
    const removedAndPantry = reconcileItems(
      [row({ excluded_reason: "manual" })],
      [draftItem({ excludedReason: "pantry" })],
    );
    expect(removedAndPantry.updates[0]?.write.excluded_reason).toBe("manual");
    const pantryNowCovers = reconcileItems([row({})], [draftItem({ excludedReason: "pantry" })]);
    expect(pantryNowCovers.updates[0]?.write.excluded_reason).toBe("pantry");
    const pantryReleased = reconcileItems([row({ excluded_reason: "pantry" })], [draftItem({})]);
    expect(pantryReleased.updates[0]?.write.excluded_reason).toBeNull();
  });

  it("pairs rows that share a key by unit first, then in order", () => {
    const existing = [
      row({ id: ID(1), unit: "cup", position: 0 }),
      row({ id: ID(2), unit: "each", position: 1 }),
    ];
    const draft = [
      draftItem({ unit: "each", qty: 2, position: 0 }),
      draftItem({ unit: "cup", qty: 1, position: 1 }),
    ];
    const result = reconcileItems(existing, draft);
    const byId = new Map(result.updates.map((u) => [u.id, u.write]));
    expect(byId.get(ID(1))?.unit).toBe("cup");
    expect(byId.get(ID(2))?.unit).toBe("each");
    expect(result.inserts).toEqual([]);
    expect(result.deletes).toEqual([]);
  });

  it("matches unparsed lines by their raw text, case-insensitively", () => {
    const result = reconcileItems(
      [row({ ingredient_id: null, display_name: "1 Handful Mystery Leaves" })],
      [draftItem({ ingredientId: null, displayName: "1 handful mystery leaves" })],
    );
    expect(result.updates).toHaveLength(1);
    expect(result.inserts).toEqual([]);
  });

  it("tells qualified and unqualified items apart", () => {
    const plain = itemMatchKey({ ingredientId: "i1", displayName: "Penne", qualifiers: [] });
    const free = itemMatchKey({
      ingredientId: "i1",
      displayName: "Penne",
      qualifiers: ["gluten-free"],
    });
    expect(plain).not.toBe(free);
    const result = reconcileItems(
      [row({ id: ID(1), qualifiers: [] })],
      [draftItem({ qualifiers: ["gluten-free"] })],
    );
    expect(result.updates).toEqual([]);
    expect(result.inserts).toHaveLength(1);
    expect(result.deletes).toEqual([ID(1)]);
  });
});

describe("a rebuild after the plan changes (acceptance criterion 4)", () => {
  const first = FIXTURES["qualifiers-never-merge"] as ListFixture;

  it("keeps every row whose ingredient is unchanged, so its checked state survives", () => {
    const before = runFixture(first).draft;
    // The list as the database holds it after the first build, with two rows checked.
    const existing: ExistingListItem[] = before.items.map((item, index) => ({
      id: ID(100 + index),
      ingredient_id: item.ingredientId,
      display_name: item.displayName,
      qualifiers: item.qualifiers,
      qty: item.qty,
      unit: item.unit,
      section: item.section,
      excluded_reason: item.excludedReason ?? null,
      is_manual: false,
      edited: false,
      position: item.position,
    }));

    // The plan changes: the celiac dinner is swapped for a recipe that needs lemons.
    const changed: ListFixture = {
      ...first,
      recipes: [
        first.recipes[0] as ListFixture["recipes"][number],
        {
          id: "lemon",
          title: "Lemon Chicken",
          servings: 4,
          lines: [{ text: "1 lemon", qty: 1, unit: "each", ingredient: "lemon" }],
        },
      ],
      entries: [
        first.entries[0] as ListFixture["entries"][number],
        { id: "e2", recipe: "lemon", servings: 4 },
      ],
    };
    const after = runFixture(changed).draft;
    const result = reconcileItems(existing, after.items);

    const keptKeys = result.updates.map((u) =>
      itemMatchKey({
        ingredientId: u.write.ingredient_id,
        displayName: u.write.display_name,
        qualifiers: u.write.qualifiers,
      }),
    );
    // Pasta Night's butter and penne are still planned: both rows are updated in place.
    const buttonRow = existing.find((r) => r.display_name === "Butter") as ExistingListItem;
    const penneRow = existing.find((r) => r.display_name === "Penne") as ExistingListItem;
    expect(result.updates.map((u) => u.id)).toEqual(
      expect.arrayContaining([buttonRow.id, penneRow.id]),
    );
    expect(keptKeys.length).toBe(result.updates.length);
    // The celiac-only rows go, and the lemon arrives as a new row.
    expect(result.deletes).toHaveLength(4);
    expect(result.inserts.map((i) => i.display_name)).toEqual(["Lemon"]);
  });

  it("is a no-op in shape when nothing changed: every row updated, none added or removed", () => {
    const draft = runFixture(first).draft;
    const existing: ExistingListItem[] = draft.items.map((item, index) => ({
      id: ID(200 + index),
      ingredient_id: item.ingredientId,
      display_name: item.displayName,
      qualifiers: item.qualifiers,
      qty: item.qty,
      unit: item.unit,
      section: item.section,
      excluded_reason: item.excludedReason ?? null,
      is_manual: false,
      edited: false,
      position: item.position,
    }));
    const again = reconcileItems(existing, buildList(runFixture(first).input).items);
    expect(again.inserts).toEqual([]);
    expect(again.deletes).toEqual([]);
    expect(again.updates).toHaveLength(existing.length);
  });
});
