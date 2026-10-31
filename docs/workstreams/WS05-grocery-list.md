# WS05: Grocery list & in-store mode

**Wave:** 4 · **Suggested model:** Sonnet · **Branch:** `ws/05-grocery-list`

## Goal
One tap turns the week's plan into a single grocery list: ingredient lines from every planned recipe are scaled by servings, converted to common units, summed per ingredient, reduced by what the pantry already has, rounded up to amounts you can buy, and grouped by store section. In the store the list works offline, items check off instantly, and household members see each other's check-offs. The list is the exact input the shopping agent (WS09) converts into retailer line items.

## Depends on
- WS03: `ingredients` ontology, `ParsedIngredient` on `recipe_ingredients`, `units.ts` (`convert`, `toPurchasable`, `normalizeUnit`).
- WS04: `meal_plans`, `meal_plan_entries` with servings, query key `['meal-plan', householdId, weekStart]`.
- WS01 and WS02 transitively (auth, recipes).

## Read first
1. `docs/03-ai-design.md` §4.6 (list aggregation) and §4.7 (what WS09 expects from a list item)
2. `docs/02-data-model.md` §Lists and pantry
3. `docs/01-architecture.md` §Clients (offline, persisted cache, Realtime)
4. `docs/06-risks.md` R2, R6

## In scope
- Migration `<timestamp>_lists.sql`: `grocery_lists`, `grocery_list_items`, `pantry_items` with RLS and Realtime publication
- `packages/core/src/list/aggregate.ts`: pure function `buildList(entries, recipes, ingredients, pantry, options) -> GroceryListDraft` that scales, normalizes, sums, excludes, rounds, and groups; `packages/core/src/list/sections.ts` with default section order and per-store overrides
- Edge Function `list-build`: loads the plan for a `weekStart`, calls `buildList`, upserts a `grocery_lists` row with `plan_id` and replaces its items while preserving `checked` state and manual edits for items whose `ingredient_id` is unchanged
- Lines with `ingredient_id = null` (unparsed) become items with `display_name = raw_text` and a "needs attention" flag; never dropped
- Pantry: screen to mark staples `have | low | out`; `is_staple_default` ingredients pre-populated as `have` for a new household; list excludes `have` items and shows them in a collapsed "Already have" group
- Manual items: add free-text items to any list; edit quantity, unit, or section; delete
- In-store mode: large check-off rows, grouped by section in store order, offline via persisted TanStack Query cache with optimistic writes and a replay queue; Realtime subscription on `grocery_list_items`
- "Why this amount" sheet per item: lists each contributing recipe, its servings, the converted quantity, and the rounding applied
- "List is out of date" banner when the plan changed after the list was built, with a one-tap rebuild

## Out of scope
- Mapping items to retailer products, prices, or carts (WS07, WS09)
- Splitting a list across stores (WS09's run policy decides; this WS stores one list per plan)
- Barcode scanning into the pantry (v2)
- Price estimates (WS09 shows them from live catalog data)
- Recipe or plan editing (WS02, WS04)

## Deliverables
- `supabase/migrations/<timestamp>_lists.sql`
- `supabase/tests/005_rls_lists.sql`
- `supabase/functions/list-build/index.ts`
- `packages/core/src/list/aggregate.ts`, `src/list/sections.ts`, `src/list/types.ts` (zod `GroceryList`, `GroceryListItem`, `GroceryListDraft`, `PantryItem`, `Section`), `src/list/aggregate.test.ts`, `src/list/fixtures/*.json`
- `packages/db/src/hooks/useGroceryList.ts`, `useGroceryListItems.ts`, `useToggleItem.ts`, `useAddManualItem.ts`, `usePantry.ts`, `useBuildList.ts`, `src/realtime/lists.ts`, `src/offline/replayQueue.ts`
- `apps/mobile/app/(app)/list/index.tsx` (current list), `list/[id].tsx`, `list/store-mode.tsx`, `pantry/index.tsx`
- `apps/mobile/src/features/list/*` (SectionGroup, ItemRow, WhyThisAmountSheet, OutOfDateBanner, AddItemBar)
- `docs/02-data-model.md`: "As built" note if columns differ

## Interfaces
**Implements**
- `grocery_lists(id, household_id, plan_id uuid null, name text, status text check in ('draft','active','shopped') default 'active', built_at timestamptz, plan_version int, created_at, updated_at, deleted_at)`
- `grocery_list_items(id, list_id, household_id, ingredient_id uuid null, display_name text, qty numeric null, unit text null, source_entry_ids uuid[] default '{}', section text, checked bool default false, checked_by uuid null, checked_at timestamptz null, excluded_reason text null check in ('pantry','manual'), needs_attention bool default false, is_manual bool default false, position int, created_at, updated_at)`
- `pantry_items(household_id, ingredient_id, status text check in ('have','low','out'), updated_at, primary key (household_id, ingredient_id))`
- `buildList(input: { entries: MealPlanEntry[]; recipes: RecipeWithIngredients[]; ingredients: Map<string, Ingredient>; pantry: PantryItem[]; options?: { sectionOrder?: string[]; roundUp?: boolean } }): GroceryListDraft` where each draft item carries `{ ingredientId, displayName, qty, unit, sourceEntryIds, section, contributions: { entryId, recipeTitle, servings, qty, unit }[], excludedReason?, needsAttention }`
- Hooks listed above in `@mp/db`; query key `['grocery-list', householdId, listId]`
- Edge Function `list-build` request `{ weekStart }` and response `{ listId, itemCount, needsAttentionCount }`

**Consumes**
- `convert`, `toPurchasable`, `normalizeUnit` from `@mp/core` (WS03); `ingredients.category` as the section key
- `meal_plan_entries`, `recipes`, `recipe_ingredients` (WS04, WS02); query key `['meal-plan', ...]` invalidation to detect staleness

If `GroceryListItem` needs fields WS09 will want (for example `retailerHints`), propose them in the completion report instead of adding them.

**Example draft item**
```json
{
  "ingredientId": "b3d9...",
  "displayName": "Yellow onion",
  "qty": 3,
  "unit": "each",
  "section": "produce",
  "sourceEntryIds": ["e1...", "e2..."],
  "contributions": [
    { "entryId": "e1...", "recipeTitle": "Chicken Tikka", "servings": 4, "qty": 1.5, "unit": "each" },
    { "entryId": "e2...", "recipeTitle": "French Onion Soup", "servings": 2, "qty": 1.2, "unit": "each" }
  ],
  "rounding": { "from": 2.7, "to": 3, "rule": "round up to whole units" },
  "needsAttention": false
}
```

**Default section order**
`produce, bakery, meat, seafood, dairy, eggs, frozen, canned, pantry, baking, spices, international, snacks, beverages, household, other`

## Acceptance criteria
1. `supabase db reset` applies the lists migration; `supabase test db` passes `005_rls_lists.sql`, including that a member cannot read another household's list and that `checked_by` must equal `auth.uid()` on update.
2. `buildList` unit tests cover: two recipes each needing "1 cup diced onion" at the recipe's servings produce one item of 2 cups; scaling 4 servings to 6 scales quantities by 1.5; "2 cloves garlic" plus "1 head garlic" produce one item in heads, rounded up; "1 lb chicken thighs" plus "8 oz chicken thighs" produce 1.5 lb; a pantry `have` item is excluded with `excludedReason = 'pantry'`; an unparsed line becomes a `needsAttention` item named by its raw text; items are grouped by section in the default order.
3. Building the list for a fixture week of 5 dinners produces a list in under 2 seconds (Edge Function timing in report) and `needsAttentionCount` matches the number of null `ingredient_id` lines.
4. Rebuilding after the plan changes preserves `checked = true` on items whose `ingredient_id` is unchanged and preserves manual items.
5. Each item's "Why this amount" sheet lists every contributing recipe with servings and converted quantity, and the rounding step when applied.
6. Marking a staple as `have` in the pantry removes it from the next build and shows it under "Already have"; marking it `out` brings it back.
7. In-store mode in airplane mode: checking 10 items updates the UI instantly; on reconnect all 10 persist with `checked_by` set and no duplicates (replay queue test or screen recording).
8. Two household members: a check-off on one device appears on the other within 3 seconds.
9. Changing the plan after a build shows the out-of-date banner; tapping rebuild clears it and updates `plan_version`.
10. Web build renders the list and store mode at 390 px and 1280 px (screenshots).
11. `pnpm typecheck`, `pnpm lint`, `pnpm test` pass.

## Verification commands
```bash
supabase db reset && supabase test db                        # lists migration applied, 005 passes
pnpm --filter @mp/core test -- list                          # aggregate tests pass
pnpm typecheck && pnpm lint && pnpm test                     # exit 0
supabase functions serve list-build                          # then:
curl -s -X POST localhost:54321/functions/v1/list-build -H "Authorization: Bearer $USER_JWT" -d '{"weekStart":"2026-11-02"}'
psql "$WORKER_DATABASE_URL" -c "select section, display_name, qty, unit, checked, needs_attention from grocery_list_items order by position limit 30"
pnpm --filter @mp/mobile start                               # manual: airplane-mode check-off, two-device realtime
```

## Risks and notes
- From the WS16 review (2026-10-30): a line's `ingredient_id` alone is not enough to buy the right product. A qualifier such as "gluten-free" or "dairy-free" on the line (today in `prep_note`; a structured field later from WS03) must survive aggregation onto the list item and reach the retailer search, or a celiac household's cart gets wheat pasta. Never merge a qualified line into an unqualified one.
- As built by WS04 (2026-10-30): `MealPlanEntry` in `@mp/core` carries `why: string | null` as a required key, so any entry query you write must select `why` or parse with a narrower schema. Entries for the week live under the query key `['meal-plan', householdId, weekStart]`, and every entry change invalidates it; set `GROCERY_LIST_ROUTE` in `apps/mobile/src/features/plan/routes.ts` so the planner's "Generate list" button becomes live. Catalog recipes (`visibility = 'catalog'`, `household_id` null) are readable by members and can be planned, so aggregation must read their `recipe_ingredients` too.
- From the WS03 review (2026-10-30): `toPurchasable(28, "oz", diced tomatoes)` returns 2 cans because `CATEGORY_PACKS.canned` assumes 411 g, so "1 (28 oz) can" double-buys, and "2 (14 oz) cans" parses to 28 oz while "2 cans (14 oz each)" parses to 2 can. Handle can sizes and the container count (see the `containerCount` question above) before aggregating.
- From the WS03 report (2026-10-30): use `qty_max` from `recipe_ingredients` when present so the aggregated list never comes up short. `convert` and `toPurchasable` in `@mp/core/units` have a pack table of about 40 entries and ignore form (sifted vs packed); extend both. Open contract question for your dispatch: optional `containerCount` and `container` on `ParsedIngredient` so "2 (14 oz) cans" keeps the can count.
- From the WS00 review (2026-10-30): TanStack Query persistence is opt-in per query with `meta: { persist: true }` and a global 24-hour maximum age. Grocery-list queries should opt in so the list works offline. Any query that returns retailer-derived data (products, prices, availability) must never set `persist`; docs/04 forbids storing search-derived data past the response's cache headers.
- Unit conversion is the main correctness risk (R2). Keep `buildList` pure and fixture-driven so every reported bug becomes a test case. Always show the contributions so the user can see and override.
- Never drop an unparsed line. A missing item in the store is worse than an odd one; `needsAttention` keeps it visible.
- Offline (R6): persist the query cache per household, queue mutations with client-generated ids, and treat `checked` as last-writer-wins by `checked_at`. Do not build CRDTs.
- Section order differs by store. Ship a default order and a per-household override now; per-store overrides can key on `retailer_connections.store_id` later (WS09 or WS12).
- Realtime payloads respect RLS; add the tables to the `supabase_realtime` publication in the migration.
- Replacing items on rebuild must happen in one transaction inside `list-build` to avoid a flash of an empty list on devices.
- Mitigates R2, R6; produces the input for R1 (matching) in WS09.

**Suggested build order**
1. `buildList` as a pure function with fixtures covering every acceptance case in criterion 2; tests green before any UI.
2. The lists migration with Realtime publication; RLS tests including the `checked_by` rule.
3. Edge Function `list-build` with transactional replace that preserves `checked` and manual items.
4. Hooks, offline replay queue, Realtime module.
5. List screen with sections, add bar, "why this amount" sheet, out-of-date banner.
6. Pantry screen and staple pre-population on household creation.
7. Store mode; airplane-mode and two-device checks; responsive screenshots.
8. Completion report with timings.

## Completion report
End with the completion report from `docs/implementation-guide.md` §6.2 (Message templates). Include the aggregate test output, Edge Function timing, and offline evidence under Verification output.
