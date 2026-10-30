# WS04: Planner UI

**Wave:** 3 · **Suggested model:** Sonnet · **Branch:** `ws/04-planner-ui`

## Goal
A household plans its week: a seven-day view with breakfast, lunch, dinner, and snack slots, recipes dropped into slots with a servings count, quick swap and skip actions, and a "cooked" mark that feeds recommendation history. Changes made by one household member appear on another's device within seconds. The plan is the input to the grocery list (WS05) and the record the suggestion engine (WS06) learns from.

## Depends on
- WS01: auth, households, `@mp/db` hooks, RLS helper `current_household_ids()`.
- WS02: `recipes` table and `useRecipes`, `useRecipe` hooks; recipe detail screen to link to.
- Runs in the same wave as WS06. The "swap with AI suggestion" action calls WS06's `suggest` function if it exists; otherwise it shows a manual recipe picker and the AI button is hidden behind a feature flag until WS06 merges.

## Read first
1. `docs/02-data-model.md` §Planning
2. `docs/03-ai-design.md` §4.3 step 4 (what feedback signals the planner must write) and §4.9 (assistant actions the planner exposes later)
3. `docs/01-architecture.md` §Clients (TanStack Query persisted cache, Realtime)
4. `docs/00-overview.md` §v1 must-haves (planner line)

## In scope
- Migration `<timestamp>_planning.sql`: `meal_plans`, `meal_plan_entries`, `recipe_feedback` with RLS
- Realtime publication for `meal_plan_entries` and `meal_plans`
- Screens: week view (default landing after onboarding), day detail, recipe picker (search household recipes, recent, favorites), entry sheet (servings, notes, swap, skip, mark cooked, remove)
- Week navigation (previous, next, jump to this week); `meal_plans` row created lazily per `week_start` (Monday)
- Servings default from `households` size if WS06 has stored one, else from the recipe's `servings`
- Feedback writes: `cooked` when marked cooked, `skipped` when skipped, `saved` when a recipe is added to any plan, `like`/`dislike` from a thumbs control on the entry sheet
- Hooks in `@mp/db`: `useMealPlan(weekStart)`, `useMealPlanEntries(planId)`, `useUpsertEntry`, `useDeleteEntry`, `useRecipeFeedback`
- Optimistic updates with rollback on error; Realtime subscription that invalidates the plan query on remote changes
- "Generate list" button that navigates to WS05's list screen when it exists, otherwise disabled with a tooltip

## Out of scope
- Grocery list generation and aggregation (WS05)
- AI week composition and the `suggest` Edge Function (WS06); this WS only calls it if present
- Nutrition totals (v2)
- Drag-and-drop across days on web beyond long-press reorder on native (nice to have, not required)
- Calendar export (v2)

## Deliverables
- `supabase/migrations/<timestamp>_planning.sql`
- `supabase/tests/004_rls_planning.sql`
- `packages/core/src/planning.ts` (zod `MealPlan`, `MealPlanEntry`, `MealSlot`, `RecipeFeedback`, helper `weekStartFor(date)`)
- `packages/db/src/hooks/useMealPlan.ts`, `useMealPlanEntries.ts`, `useUpsertEntry.ts`, `useDeleteEntry.ts`, `useRecipeFeedback.ts`, `src/realtime/planning.ts`
- `apps/mobile/app/(app)/plan/index.tsx` (week view), `plan/[date].tsx` (day detail), `plan/pick.tsx` (recipe picker modal)
- `apps/mobile/src/features/plan/*` (WeekGrid, SlotCell, EntrySheet, ServingsStepper, SwapMenu)
- `packages/ui`: `Sheet`, `Stepper`, `SegmentedControl`, `EmptyState` primitives if not already present
- `docs/02-data-model.md`: "As built" note if columns differ

## Interfaces
**Implements**
- `meal_plans(id, household_id, week_start date, created_at, updated_at, unique (household_id, week_start))`
- `meal_plan_entries(id, plan_id, household_id, date date, slot text check in ('breakfast','lunch','dinner','snack'), recipe_id, servings int, status text check in ('planned','cooked','skipped') default 'planned', notes text, position int, created_at, updated_at)`; `household_id` is denormalized onto entries so the standard RLS policy applies without a join
- `recipe_feedback(id, household_id, user_id, recipe_id, signal text check in ('like','dislike','cooked','skipped','saved'), rating int null, created_at)`
- zod `MealPlan`, `MealPlanEntry`, `MealSlot`, `RecipeFeedback`, `weekStartFor(date): string` in `@mp/core`
- Hooks listed above in `@mp/db`
- Route `/plan` as the app's home tab; `/plan/[date]`; `/plan/pick?date=&slot=`
- Event: when an entry changes, invalidate query key `['meal-plan', householdId, weekStart]`; WS05 listens to the same key to offer "list is out of date"

**Consumes**
- `recipes`, `useRecipes` from WS02; `households`, `useHousehold` from WS01
- Optional: `suggest` Edge Function from WS06 for "swap with a suggestion" (feature-flagged by the function's presence)

Do not change `recipes` or `profiles`. Request changes in the report.

**Example entry upsert payload**
```json
{
  "plan_id": "4f1c...",
  "household_id": "9a2b...",
  "date": "2026-11-03",
  "slot": "dinner",
  "recipe_id": "c77e...",
  "servings": 4,
  "status": "planned",
  "position": 0
}
```

**Realtime subscription sketch**
```ts
supabase.channel(`plan:${householdId}`)
  .on('postgres_changes', { event: '*', schema: 'public', table: 'meal_plan_entries',
       filter: `household_id=eq.${householdId}` },
      () => queryClient.invalidateQueries({ queryKey: ['meal-plan', householdId] }))
  .subscribe();
```

## Acceptance criteria
1. `supabase db reset` applies `0006`; `supabase test db` passes `004_rls_planning.sql` proving cross-household reads and writes on `meal_plan_entries` and `recipe_feedback` fail.
2. Opening the plan tab for a week with no plan creates a `meal_plans` row lazily on first entry, not on view (verified by row count before and after).
3. Adding a recipe to Tuesday dinner with 4 servings creates an entry with `slot = 'dinner'`, `servings = 4`, `status = 'planned'` and a `recipe_feedback` row with `signal = 'saved'`.
4. Marking an entry cooked sets `status = 'cooked'` and writes `signal = 'cooked'`; skipping writes `skipped`.
5. Two devices signed in as different members of the same household: adding an entry on one appears on the other within 3 seconds without a manual refresh (screen recording or two screenshots with timestamps in the report).
6. Turning on airplane mode, changing servings, then reconnecting: the change persists and no duplicate entry is created (optimistic update plus upsert).
7. Week navigation shows correct Monday-based `week_start` across a month boundary and a DST change (unit tests on `weekStartFor`).
8. Recipe picker search returns results from the household's recipes by title within 300 ms on a 200-recipe fixture (log timing in report).
9. With WS06 absent, the AI swap button is hidden and manual swap works; with WS06 present (if merged before review), the AI swap button appears and replaces the entry with the returned recipe.
10. Web build renders the week view responsively at 390 px and 1280 px widths (screenshots).
11. `pnpm typecheck`, `pnpm lint`, `pnpm test` pass.

## Verification commands
```bash
supabase db reset && supabase test db                 # 0006 applied, 004 passes
pnpm typecheck && pnpm lint && pnpm test              # exit 0
pnpm --filter @mp/core test -- planning               # weekStartFor tests
pnpm --filter @mp/mobile start                        # manual: two simulators or simulator + web for realtime check
psql "$WORKER_DATABASE_URL" -c "select slot, servings, status from meal_plan_entries order by created_at desc limit 5"
psql "$WORKER_DATABASE_URL" -c "select signal, count(*) from recipe_feedback group by 1"
```

## Risks and notes
- From the orchestrator (2026-10-30), as built by WS02: `@mp/db` exports `useRecipes`, `useRecipe`, `useImportRecipe` and `useRecipeImageUrl`; recipes are soft-deleted (`deleted_at`) and the hooks already filter them; `recipe_ingredients.qty` is the lower bound of a range and `qty_max` the upper; a recipe's `source_url` attribution must stay reachable wherever you show a recipe, so link to the detail screen rather than reproducing it.
- From the orchestrator (2026-10-30), servings default: profiles are private per user, so "household size" is not readable across members. Default an entry's servings from the current user's `ProfilePreferences.portions`, else `household_size.adults + household_size.kids`, else the recipe's `servings`.
- From the orchestrator (2026-10-30), wave 3 sequencing: WS06 builds in parallel and, through the `suggest` Edge Function on the service role, inserts the first `meal_plans` and `meal_plan_entries` and writes `recipe_feedback` rows (`like` and `dislike` from calibration swipes). Keep the docs/02 §Planning shapes exactly, let the service role write all three tables, and keep client grants household-scoped and column-level where a client may update (`servings`, `status`, `notes`, `position` on entries). Name the migration with a timestamp after `20261030110000`, and merge main before your report.
- Denormalizing `household_id` onto `meal_plan_entries` keeps RLS simple and fast; keep it in sync with a trigger from `meal_plans` on insert.
- Supabase Realtime needs the tables added to the `supabase_realtime` publication in the migration; RLS applies to Realtime payloads, so members only receive their household's changes.
- Persisted TanStack Query cache must be keyed by household so switching households does not show stale plans.
- Long-press drag on native and click-to-move on web is enough for v1; do not spend time on cross-platform drag libraries (R8).
- The planner is where "ingredient overlap" from WS06 becomes visible; leave a slot in the entry sheet for a one-line "why this" from the suggestion payload.
- Mitigates R6 partially (offline edits) and feeds R12 differentiation (household loop).

**Suggested build order**
1. Migration `0006` with the `household_id` sync trigger and Realtime publication; RLS tests.
2. `@mp/core` planning schemas and `weekStartFor` with DST and month-boundary tests.
3. Hooks with optimistic updates; Realtime subscription module.
4. Week view and day detail with static data, then wire hooks.
5. Recipe picker and entry sheet (servings, swap, skip, cooked, remove, thumbs).
6. Feedback writes; verify rows in `recipe_feedback`.
7. Two-device realtime check; airplane-mode check; responsive screenshots.
8. Feature flag for the AI swap button keyed on WS06 presence; completion report.

## Completion report
End with the completion report from `docs/implementation-guide.md` §6.2 (Message templates). Include the realtime evidence and the two responsive screenshots under Verification output.
