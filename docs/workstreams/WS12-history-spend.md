# WS12: History & spend

**Wave:** 6 · **Suggested model:** Sonnet · **Branch:** `ws/12-history-spend`

## Goal
When this is done, the household can look back: which meals were cooked each week, what each shopping run cost and at which store, and which products they buy most. Because no retailer exposes order history through an API today, the `orders` table is built from our own run ledger plus the user's confirmation that they placed the order. History also feeds the recommendation loop (WS06) with "cooked" signals and gives the agent (WS09) a reliable picture of past purchases.

## Depends on
- WS09 (Shopping agent + worker): `shopping_runs` and `shopping_run_items` with final statuses and `subtotal`; the review screen where the user approves a cart.
- WS05 (Grocery list): `grocery_lists` linked to `meal_plans`.
- WS04 (Planner UI): `meal_plan_entries.status` with the `cooked` value written by the planner.
- WS07 (Retailer framework): `retailer_connections.store_name` and `product_matches` (user-pinned product preferences).
- WS01 (Auth & households): RLS pattern.

## Read first
1. `docs/02-data-model.md` (Retail tables: `orders`, `shopping_runs`, `shopping_run_items`, `product_matches`; Planning: `meal_plan_entries`)
2. `docs/04-integrations.md` §5.2 Kroger terms (what we may and may not store) and §5.3 feasibility matrix (order history column)
3. `docs/06-risks.md` (R21 Kroger terms vs memory features, R19 hand-off perception)
4. `docs/05-security-privacy.md` (purchase history is sensitive; export and delete endpoints)
5. `docs/03-ai-design.md` §4.3 (how `recipe_feedback` and cooked signals feed suggestions)

## In scope
- `orders` rows created from a finished run: when a run reaches `cart_ready` and the user later confirms "I placed it", the app writes an `orders` row with the run's final line items, the user-entered total (prefilled with the run subtotal), modality, and an optional pickup window.
- The "Did you place this order?" prompt: appears on the run detail screen after `cart_ready`, and as a follow-up notification 2 hours after `cart_ready` if unanswered (uses WS11 `send-push` with type `items_need_review`? No. Add no new push type; use an in-app banner only).
- Pickup window capture: user enters `slot_start` and `slot_end` (optional). WS11 reads these for the pickup reminder.
- History screens in `apps/mobile`:
  - Meals: per week, entries with `status = cooked`, grouped by date, with a cooked count and streak.
  - Spend: per week and per store, from `orders.total`; a simple bar list, no charts library required.
  - Most bought: top 20 products by count of `shopping_run_items` rows with `status in ('matched','substituted')` across confirmed orders, joined to `product_matches` for pinned status, with a "pin" toggle that writes `product_matches.pinned`.
- SQL views: `v_meals_cooked_weekly`, `v_spend_weekly_by_store`, `v_most_bought_products`, all RLS-safe (security invoker).
- Export-my-data: extend the WS01 export endpoint (or add `supabase/functions/export-data`) to include `orders`, `shopping_runs` (without transcripts), and `meal_plan_entries`.
- Delete-my-data: deleting a household cascades to `orders`.

## Out of scope
- Syncing orders from any retailer API. None exists in a public tier (Kroger, Instacart, Safeway, Costco). Document this in the screen's empty state.
- Price trends for pinned items over time. **Deferred** pending written clarification from Kroger on storing data derived from catalog searches (R21). Do not store `unit_price` history beyond what `shopping_run_items` already holds for the run itself.
- Receipts, OCR of receipts, or loyalty program integration.
- Nutrition totals or calorie tracking.
- Budgeting advice or spend forecasts.
- Any change to how runs are executed (WS09) or how `cooked` is marked (WS04).

## Deliverables
- `supabase/migrations/<timestamp>_orders_and_history.sql`: `orders` table (owned by this WS; WS09 does not create it) with `confirmed_by`, `confirmed_at`, `notes`, the three views, RLS, indexes on `(household_id, created_at)`.
- `packages/db/src/queries/orders.ts`: `confirmOrder(runId, {total, modality, slotStart?, slotEnd?})`, `listOrders(householdId, range)`.
- `packages/db/src/queries/history.ts`: typed readers for the three views.
- `packages/core/src/history/week.ts`: `weekStart(date, tz)` and `groupByWeek` pure helpers with tests (reuse `packages/core/src/schedule/` helpers from WS11 if present; do not duplicate).
- `apps/mobile/app/(app)/history/index.tsx` (tabs: Meals, Spend, Most bought), `apps/mobile/app/(app)/history/orders/[id].tsx`.
- `apps/mobile/src/runs/ConfirmOrderSheet.tsx`: the "Did you place this order?" sheet, launched from the WS09 run detail screen via a prop or route param (coordinate: WS09 exposes a slot; if it does not, file a contract change request).
- `supabase/tests/orders_rls.sql` (pgTAP).
- `supabase/functions/export-data/index.ts` or an extension to the existing export function, with a test fixture.
- `docs/02-data-model.md`: add `confirmed_by`, `confirmed_at`, `notes` to `orders` and list the three views.

## Interfaces
**Implements**
- Table `orders` (id, household_id, run_id → shopping_runs, retailer text, retailer_order_id text nullable, modality 'pickup'|'delivery', slot_start timestamptz nullable, slot_end timestamptz nullable, total numeric, status 'confirmed'|'cancelled', confirmed_by uuid → auth.users, confirmed_at timestamptz, notes text, raw jsonb, created_at).
- Views: `v_meals_cooked_weekly(household_id, week_start, cooked_count, entries jsonb)`, `v_spend_weekly_by_store(household_id, week_start, retailer, store_name, total)`, `v_most_bought_products(household_id, retailer, upc, product_name, times_bought, pinned)`.
- Query functions listed in Deliverables.

**Consumes**
- `shopping_runs(id, household_id, connection_id, status, subtotal, finished_at)` and `shopping_run_items(run_id, product_id, product_name, qty, unit_price, line_total, status)` from WS09.
- `retailer_connections(id, retailer, store_name, modality)` and `product_matches(household_id, retailer, upc, product_name, pinned)` from WS07.
- `meal_plan_entries(plan_id, date, recipe_id, status)` and `meal_plans(household_id, week_start)` from WS04.
- Export endpoint from WS01 (extend, do not replace).
- Shared contracts are owned by the orchestrator. Request changes; do not edit `packages/core` types beyond adding the new `history/` module.

## Acceptance criteria
1. `supabase db reset` applies the WS12 migration; `supabase test db` passes `orders_rls.sql` (cross-household read and write both fail).
2. Confirming a `cart_ready` run through `ConfirmOrderSheet` inserts one `orders` row with `status = 'confirmed'`, `total` equal to the entered value, `confirmed_by` equal to the current user, and `run_id` pointing at the run. Confirming the same run twice is rejected with a clear error (unique on `run_id`).
3. `v_spend_weekly_by_store` returns one row per (week, store) with totals that equal the sum of confirmed `orders.total` for that week, verified by a SQL test with three seeded orders across two stores and two weeks.
4. `v_meals_cooked_weekly` counts only entries with `status = 'cooked'`; a seeded plan with 5 entries of which 3 are cooked returns `cooked_count = 3`.
5. `v_most_bought_products` orders by `times_bought` descending and reflects `product_matches.pinned`; toggling pin in the UI updates the view result on refresh.
6. The History screen renders all three tabs with seeded data on iOS Simulator and on web (`pnpm --filter mobile start`, press `w`), and shows the documented empty state ("Orders appear here after you confirm a shopping run. Stores do not share order history with apps yet.") when there are none.
7. The export function output includes `orders`, `shopping_runs` without the `transcript` field, and `meal_plan_entries`, as JSON, for the calling user's household only.
8. Deleting a test household removes its `orders` rows (cascade verified in a pgTAP test).
9. No table or column added by this WS stores price history for products outside a specific run (grep the migration for `price` and confirm only `orders.total` and existing `shopping_run_items` columns are involved).
10. `pnpm typecheck && pnpm lint && pnpm test` pass at the repo root.

## Verification commands
```bash
supabase start && supabase db reset        # expected: clean apply
supabase test db                            # expected: orders_rls.sql and view tests pass
pnpm test --filter core                     # expected: history helpers pass
pnpm test --filter db                       # expected: query tests against local Supabase pass
supabase functions serve export-data        # then curl with a user JWT; expected JSON with orders, runs, entries
pnpm typecheck && pnpm lint && pnpm test    # expected: clean
pnpm --filter mobile start                  # manual: History tabs render; confirm an order from a cart_ready run
```

## Risks and notes
- From the WS01 review (2026-10-30): `export-data` pages every table with `.range()` and requires a total `ORDER` entry per table in `supabase/functions/export-data/handler.ts`; add one for each table you export. Exported `household_invites` redact `token`; redact any bearer or secret column you add the same way.
- R21: Kroger's developer terms prohibit storing data derived from customer searches or cart adds and building a cached catalog. `orders` records what the household bought, entered with the user's confirmation, which is the household's own purchase record. Keep it to that: no product descriptions beyond `product_name`, no images, no cached prices beyond the run. Price-over-time is deferred.
- R19: never show an order as "placed" without the user's confirmation. The run reaching `cart_ready` is not an order.
- Purchase history is sensitive. Views use `security_invoker = true` so RLS applies. Export must filter by the caller's household through RLS, not by a parameter.
- Timezone: week boundaries use the household's timezone (from `households.quiet_hours.tz` if set by WS11, else America/Los_Angeles). Reuse WS11's helper rather than writing a second one.
- If WS09 already created `orders` with a different shape, align to this brief with an `alter table` migration and note the delta in the report.

## Completion report
End with the completion report format from `docs/implementation-guide.md` §6.2 (Message templates). Nothing else is read by the orchestrator.
