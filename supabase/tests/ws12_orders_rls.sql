-- WS12: pgTAP tests for orders, confirm_order, the three history views, and the cascade on a
-- household delete. Run with `supabase test db`. Everything happens inside one transaction that is
-- rolled back. Counts are scoped to the fixtures below: `db reset` loads the ontology and the
-- starter catalog, so nothing here counts a whole table.
--
-- What it proves:
--   * orders is readable by the members of its household and nobody else; clients cannot insert or
--     delete a row, cannot move it to another run, household or retailer, and can correct only the
--     columns the grant lists; the service role can write it, and a sync trigger puts the
--     household and retailer of the run on whatever it writes
--   * confirm_order records an order for an approved run whose cart is ready (or checked out),
--     stamps the caller as confirmed_by, takes the modality from the run's connection by default,
--     refuses a second order for a run, a run of another household, a run of a soft-deleted
--     household, a run that was never approved, an approved run that is failed, cancelled, running
--     or checking out (each on its own, so the status check is proven apart from the approval
--     check), a bad total and a bad window; a delivery connection gives a delivery order
--   * v_spend_weekly_by_store: one row per (week, store), totals equal to the sum of confirmed
--     order totals, cancelled orders left out, weeks cut in the household's zone (a Sunday night
--     in Los Angeles is that week, not the next one in UTC)
--   * v_meals_cooked_weekly counts only cooked entries (5 entries, 3 cooked, count 3)
--   * v_most_bought_products comes out in its own order (most bought, then most recent: read with
--     no ORDER BY of ours), counts only lines the store's cart holds on confirmed orders of an
--     approved run, and reflects product_matches.pinned, per store
--   * all three views are security_invoker: a member of B sees none of A's rows through them
--   * nothing added by WS12 stores a product price (no column named like one)
--   * deleting a household removes its orders
--
-- Cast (fixed ids, matching the other test files; erin belongs to a soft-deleted household C):
--   alice  owns household A       carol  is a plain member of A
--   bob    owns household B       dave   belongs to no household

begin;

select plan(135);

-- ---------------------------------------------------------------------------------------
-- Fixtures (as the postgres role, which bypasses RLS)
-- ---------------------------------------------------------------------------------------

create function public.__t_affected(sql text) returns bigint
language plpgsql as $$
declare n bigint;
begin
  execute sql;
  get diagnostics n = row_count;
  return n;
end;
$$;
grant execute on function public.__t_affected(text) to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('a1111111-1111-4111-8111-111111111111', 'alice@example.test', '{}'),
  ('b2222222-2222-4222-8222-222222222222', 'bob@example.test', '{}'),
  ('c3333333-3333-4333-8333-333333333333', 'carol@example.test', '{}'),
  ('d4444444-4444-4444-8444-444444444444', 'dave@example.test', '{}'),
  ('e5555555-5555-4555-8555-555555555555', 'erin@example.test', '{}');

insert into public.households (id, name, created_by) values
  ('0a000000-0000-4000-8000-00000000000a', 'Alice House', 'a1111111-1111-4111-8111-111111111111'),
  ('0b000000-0000-4000-8000-00000000000b', 'Bob House', 'b2222222-2222-4222-8222-222222222222');
-- Erin's household is soft-deleted (the last member left): its runs are no one's to confirm.
insert into public.households (id, name, created_by, deleted_at) values
  ('0c000000-0000-4000-8000-00000000000c', 'Erin House', 'e5555555-5555-4555-8555-555555555555', now());

insert into public.household_members (household_id, user_id, role) values
  ('0a000000-0000-4000-8000-00000000000a', 'a1111111-1111-4111-8111-111111111111', 'owner'),
  ('0a000000-0000-4000-8000-00000000000a', 'c3333333-3333-4333-8333-333333333333', 'member'),
  ('0b000000-0000-4000-8000-00000000000b', 'b2222222-2222-4222-8222-222222222222', 'owner'),
  ('0c000000-0000-4000-8000-00000000000c', 'e5555555-5555-4555-8555-555555555555', 'owner');

insert into public.ingredients (id, name, category, default_unit) values
  ('12000000-0000-4000-8000-000000000001', 'ws12 test onion', 'produce', 'each'),
  ('12000000-0000-4000-8000-000000000002', 'ws12 test milk', 'dairy', 'gallon'),
  ('12000000-0000-4000-8000-000000000003', 'ws12 test eggs', 'eggs', 'dozen'),
  ('12000000-0000-4000-8000-000000000004', 'ws12 test rice', 'pantry', 'lb');

insert into public.grocery_lists (id, household_id, name) values
  ('92000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', 'ws12 A week'),
  ('92000000-0000-4000-8000-0000000000b1', '0b000000-0000-4000-8000-00000000000b', 'ws12 B week'),
  ('92000000-0000-4000-8000-0000000000c1', '0c000000-0000-4000-8000-00000000000c', 'ws12 C week');

insert into public.grocery_list_items (id, list_id, household_id, ingredient_id, display_name, qty, unit, section) values
  ('82000000-0000-4000-8000-0000000000a1', '92000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', '12000000-0000-4000-8000-000000000001', 'Yellow onions', 2, 'each', 'produce'),
  ('82000000-0000-4000-8000-0000000000a2', '92000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', '12000000-0000-4000-8000-000000000002', 'Whole milk', 1, 'gallon', 'dairy'),
  ('82000000-0000-4000-8000-0000000000a3', '92000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', '12000000-0000-4000-8000-000000000003', 'Eggs', 1, 'dozen', 'eggs'),
  ('82000000-0000-4000-8000-0000000000a4', '92000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', '12000000-0000-4000-8000-000000000004', 'Rice', 2, 'lb', 'pantry'),
  ('82000000-0000-4000-8000-0000000000b1', '92000000-0000-4000-8000-0000000000b1', '0b000000-0000-4000-8000-00000000000b', '12000000-0000-4000-8000-000000000001', 'Yellow onions', 2, 'each', 'produce');

-- Connections with no secret (auth_type none), so no Vault is needed. Duvall is a pickup
-- connection and Redmond a delivery one, so confirm_order's default modality can be checked.
insert into public.retailer_connections (
  id, household_id, user_id, retailer, auth_type, store_id, store_name, modality, status
) values
  ('72000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', 'a1111111-1111-4111-8111-111111111111', 'kroger', 'none', 'MOCK0001', 'Mock QFC Duvall', 'pickup', 'active'),
  ('72000000-0000-4000-8000-0000000000a2', '0a000000-0000-4000-8000-00000000000a', 'c3333333-3333-4333-8333-333333333333', 'kroger', 'none', 'MOCK0003', 'Mock QFC Redmond', 'delivery', 'active'),
  ('72000000-0000-4000-8000-0000000000b1', '0b000000-0000-4000-8000-00000000000b', 'b2222222-2222-4222-8222-222222222222', 'kroger', 'none', 'MOCK0002', 'Mock Fred Meyer Monroe', 'pickup', 'active');

-- Runs. Inserted straight into their resting state: the status guard checks transitions on
-- update, not on insert.
--   a1 a3 a8  cart_ready at Duvall        a2 a7 ad   cart_ready at Redmond (a delivery connection)
--   a4        queued                      a5 ae      cart_ready but never approved
--   a6        checked_out at Duvall       b1         cart_ready in household B
--   a9 aa ab ac   APPROVED, but failed, cancelled, running and checking_out in turn: the
--                 approval cannot be what refuses them, so the status is
--   c1        cart_ready and approved, in a household that was soft-deleted
-- ae also gets an order and a line, to show the most-bought view still wants an approved run.
insert into public.shopping_runs (
  id, household_id, list_id, connection_id, retailer, store_id, store_name, status, approved_at,
  finished_at, subtotal_usd, transcript, cart_snapshot
) values
  ('f2000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', '92000000-0000-4000-8000-0000000000a1', '72000000-0000-4000-8000-0000000000a1', 'kroger', 'MOCK0001', 'Mock QFC Duvall', 'cart_ready', now(), now(), 98.00, '[{"tool": "search_products"}]', '{"summary": "ready"}'),
  ('f2000000-0000-4000-8000-0000000000a2', '0a000000-0000-4000-8000-00000000000a', '92000000-0000-4000-8000-0000000000a1', '72000000-0000-4000-8000-0000000000a2', 'kroger', 'MOCK0003', 'Mock QFC Redmond', 'cart_ready', now(), now(), 55.00, '[]', null),
  ('f2000000-0000-4000-8000-0000000000a3', '0a000000-0000-4000-8000-00000000000a', '92000000-0000-4000-8000-0000000000a1', '72000000-0000-4000-8000-0000000000a1', 'kroger', 'MOCK0001', 'Mock QFC Duvall', 'cart_ready', now(), now(), 80.00, '[]', null),
  ('f2000000-0000-4000-8000-0000000000a4', '0a000000-0000-4000-8000-00000000000a', '92000000-0000-4000-8000-0000000000a1', '72000000-0000-4000-8000-0000000000a1', 'kroger', 'MOCK0001', 'Mock QFC Duvall', 'queued', null, null, null, '[]', null),
  ('f2000000-0000-4000-8000-0000000000a5', '0a000000-0000-4000-8000-00000000000a', '92000000-0000-4000-8000-0000000000a1', '72000000-0000-4000-8000-0000000000a1', 'kroger', 'MOCK0001', 'Mock QFC Duvall', 'cart_ready', null, now(), 12.00, '[]', null),
  ('f2000000-0000-4000-8000-0000000000a6', '0a000000-0000-4000-8000-00000000000a', '92000000-0000-4000-8000-0000000000a1', '72000000-0000-4000-8000-0000000000a1', 'kroger', 'MOCK0001', 'Mock QFC Duvall', 'checked_out', now(), now(), 20.00, '[]', null),
  ('f2000000-0000-4000-8000-0000000000a7', '0a000000-0000-4000-8000-00000000000a', '92000000-0000-4000-8000-0000000000a1', '72000000-0000-4000-8000-0000000000a2', 'kroger', 'MOCK0003', 'Mock QFC Redmond', 'cart_ready', now(), now(), 10.00, '[]', null),
  ('f2000000-0000-4000-8000-0000000000a8', '0a000000-0000-4000-8000-00000000000a', '92000000-0000-4000-8000-0000000000a1', '72000000-0000-4000-8000-0000000000a1', 'kroger', 'MOCK0001', 'Mock QFC Duvall', 'cart_ready', now(), now(), 5.00, '[]', null),
  ('f2000000-0000-4000-8000-0000000000b1', '0b000000-0000-4000-8000-00000000000b', '92000000-0000-4000-8000-0000000000b1', '72000000-0000-4000-8000-0000000000b1', 'kroger', 'MOCK0002', 'Mock Fred Meyer Monroe', 'cart_ready', now(), now(), 40.00, '[]', null),
  ('f2000000-0000-4000-8000-0000000000a9', '0a000000-0000-4000-8000-00000000000a', '92000000-0000-4000-8000-0000000000a1', '72000000-0000-4000-8000-0000000000a1', 'kroger', 'MOCK0001', 'Mock QFC Duvall', 'failed', now(), now(), 14.00, '[]', null),
  ('f2000000-0000-4000-8000-0000000000aa', '0a000000-0000-4000-8000-00000000000a', '92000000-0000-4000-8000-0000000000a1', '72000000-0000-4000-8000-0000000000a1', 'kroger', 'MOCK0001', 'Mock QFC Duvall', 'cancelled', now(), now(), 15.00, '[]', null),
  ('f2000000-0000-4000-8000-0000000000ab', '0a000000-0000-4000-8000-00000000000a', '92000000-0000-4000-8000-0000000000a1', '72000000-0000-4000-8000-0000000000a1', 'kroger', 'MOCK0001', 'Mock QFC Duvall', 'running', now(), null, 16.00, '[]', null),
  ('f2000000-0000-4000-8000-0000000000ac', '0a000000-0000-4000-8000-00000000000a', '92000000-0000-4000-8000-0000000000a1', '72000000-0000-4000-8000-0000000000a1', 'kroger', 'MOCK0001', 'Mock QFC Duvall', 'checking_out', now(), null, 17.00, '[]', null),
  ('f2000000-0000-4000-8000-0000000000ad', '0a000000-0000-4000-8000-00000000000a', '92000000-0000-4000-8000-0000000000a1', '72000000-0000-4000-8000-0000000000a2', 'kroger', 'MOCK0003', 'Mock QFC Redmond', 'cart_ready', now(), now(), 33.00, '[]', null),
  ('f2000000-0000-4000-8000-0000000000ae', '0a000000-0000-4000-8000-00000000000a', '92000000-0000-4000-8000-0000000000a1', '72000000-0000-4000-8000-0000000000a1', 'kroger', 'MOCK0001', 'Mock QFC Duvall', 'cart_ready', null, now(), 0.00, '[]', null),
  ('f2000000-0000-4000-8000-0000000000c1', '0c000000-0000-4000-8000-00000000000c', '92000000-0000-4000-8000-0000000000c1', null, 'kroger', 'MOCK0009', 'Mock QFC Gone', 'cart_ready', now(), now(), 25.00, '[]', null);

-- Run lines. household_id is overwritten from the run by the items trigger.
insert into public.shopping_run_items (
  run_id, household_id, list_item_id, position, display_name, product_id, upc, product_name, size,
  qty, unit_price_usd, line_total_usd, status, user_decision, cart_qty
) values
  -- a1: onion and milk in the cart, eggs rejected by the store, a free-text line, a removed line,
  -- and a line with no product.
  ('f2000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-0000000000a1', 0, 'Yellow onions', 'P-ONION', '0099010000004', 'Harbor Fields Yellow Onions', '3 lb bag', 1, 3.49, 3.49, 'matched', 'accepted', 1),
  ('f2000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-0000000000a2', 1, 'Whole milk', 'P-MILK', '0099020000001', 'Northfork Creamery Whole Milk', '1 gal', 1, 4.29, 4.29, 'matched', 'accepted', 1),
  ('f2000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-0000000000a3', 2, 'Eggs', 'P-EGGS', '0099030000001', 'Meadow Farms Large Eggs', '12 ct', 1, 3.99, 3.99, 'matched', 'accepted', 0),
  ('f2000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', null, 3, 'Birthday candles', 'P-FREE', '0099040000001', 'Party Candles', '24 ct', 1, 2.99, 2.99, 'matched', 'accepted', 1),
  ('f2000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', null, 4, 'Cookies', 'P-GONE', '0099050000001', 'Chocolate Cookies', '12 oz', 1, 3.19, 3.19, 'matched', 'removed', 0),
  ('f2000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', null, 5, 'Saffron', null, null, null, null, 1, null, null, 'unmatched', null, 0),
  -- a3: the onion again (a newer bag name), and a substituted milk.
  ('f2000000-0000-4000-8000-0000000000a3', '0a000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-0000000000a1', 0, 'Yellow onions', 'P-ONION', '0099010000004', 'Harbor Fields Yellow Onions, 3 lb', '3 lb bag', 2, 3.59, 7.18, 'matched', 'accepted', 2),
  ('f2000000-0000-4000-8000-0000000000a3', '0a000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-0000000000a2', 1, 'Whole milk', 'P-MILK2', '0099020000002', 'Cedar Valley Whole Milk', '1 gal', 1, 4.09, 4.09, 'substituted', 'swapped', 1),
  -- a2 at the other store: the same milk product, a different store.
  ('f2000000-0000-4000-8000-0000000000a2', '0a000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-0000000000a2', 0, 'Whole milk', 'P-MILK', '0099020000001', 'Northfork Creamery Whole Milk', '1 gal', 1, 4.39, 4.39, 'matched', 'accepted', 1),
  -- a6 ends as a cancelled order: its onion must not count.
  ('f2000000-0000-4000-8000-0000000000a6', '0a000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-0000000000a1', 0, 'Yellow onions', 'P-ONION', '0099010000004', 'Harbor Fields Yellow Onions', '3 lb bag', 1, 3.49, 3.49, 'matched', 'accepted', 1),
  -- The same rice at both stores, pinned at Duvall only.
  ('f2000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-0000000000a4', 6, 'Rice', 'P-RICE', '0099060000001', 'Golden Fields Long Grain Rice', '2 lb', 1, 2.99, 2.99, 'matched', 'accepted', 1),
  ('f2000000-0000-4000-8000-0000000000a2', '0a000000-0000-4000-8000-00000000000a', '82000000-0000-4000-8000-0000000000a4', 1, 'Rice', 'P-RICE', '0099060000001', 'Golden Fields Long Grain Rice', '2 lb', 1, 3.09, 3.09, 'matched', 'accepted', 1),
  -- ae was never approved, so a line the store's cart holds on it is still not "bought".
  ('f2000000-0000-4000-8000-0000000000ae', '0a000000-0000-4000-8000-00000000000a', null, 0, 'Pretzels', 'P-UNAPPR', '0099070000001', 'Salty Pretzels', '8 oz', 1, 2.49, 2.49, 'matched', 'accepted', 1),
  -- B's own line.
  ('f2000000-0000-4000-8000-0000000000b1', '0b000000-0000-4000-8000-00000000000b', '82000000-0000-4000-8000-0000000000b1', 0, 'Yellow onions', 'P-ONION', '0099010000004', 'Harbor Fields Yellow Onions', '3 lb bag', 1, 3.49, 3.49, 'matched', 'accepted', 1);

-- What the household has pinned: the onion and the rice at Duvall, not the milk, and nothing at
-- Redmond.
insert into public.product_matches (
  household_id, retailer, store_id, ingredient_id, product_id, upc, product_name, size, chosen_by, pinned
) values
  ('0a000000-0000-4000-8000-00000000000a', 'kroger', 'MOCK0001', '12000000-0000-4000-8000-000000000001', 'P-ONION', '0099010000004', 'Harbor Fields Yellow Onions', '3 lb bag', 'user', true),
  ('0a000000-0000-4000-8000-00000000000a', 'kroger', 'MOCK0001', '12000000-0000-4000-8000-000000000002', 'P-MILK', '0099020000001', 'Northfork Creamery Whole Milk', '1 gal', 'agent', false),
  ('0a000000-0000-4000-8000-00000000000a', 'kroger', 'MOCK0001', '12000000-0000-4000-8000-000000000004', 'P-RICE', '0099060000001', 'Golden Fields Long Grain Rice', '2 lb', 'user', true);

-- Plans. Week of 2026-11-02 has five entries, three of them cooked; the next week has one cooked.
-- Household B has two cooked entries of its own.
insert into public.recipes (id, household_id, title, source_type) values
  ('42000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', 'ws12 Lemon chicken', 'manual'),
  ('42000000-0000-4000-8000-0000000000a2', '0a000000-0000-4000-8000-00000000000a', 'ws12 Green curry', 'manual'),
  ('42000000-0000-4000-8000-0000000000b1', '0b000000-0000-4000-8000-00000000000b', 'ws12 Bob chili', 'manual');

insert into public.meal_plans (id, household_id, week_start) values
  ('32000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', '2026-11-02'),
  ('32000000-0000-4000-8000-0000000000a2', '0a000000-0000-4000-8000-00000000000a', '2026-11-09'),
  ('32000000-0000-4000-8000-0000000000b1', '0b000000-0000-4000-8000-00000000000b', '2026-11-02');

insert into public.meal_plan_entries (id, plan_id, household_id, date, slot, recipe_id, servings, status, position) values
  ('22000000-0000-4000-8000-000000000001', '32000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', '2026-11-03', 'dinner', '42000000-0000-4000-8000-0000000000a1', 4, 'cooked', 0),
  ('22000000-0000-4000-8000-000000000002', '32000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', '2026-11-02', 'dinner', '42000000-0000-4000-8000-0000000000a2', 4, 'cooked', 0),
  ('22000000-0000-4000-8000-000000000003', '32000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', '2026-11-05', 'dinner', '42000000-0000-4000-8000-0000000000a1', 4, 'cooked', 0),
  ('22000000-0000-4000-8000-000000000004', '32000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', '2026-11-04', 'dinner', '42000000-0000-4000-8000-0000000000a2', 4, 'skipped', 0),
  ('22000000-0000-4000-8000-000000000005', '32000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', '2026-11-06', 'dinner', '42000000-0000-4000-8000-0000000000a1', 4, 'planned', 0),
  ('22000000-0000-4000-8000-000000000006', '32000000-0000-4000-8000-0000000000a2', '0a000000-0000-4000-8000-00000000000a', '2026-11-09', 'lunch', '42000000-0000-4000-8000-0000000000a2', 2, 'cooked', 0),
  ('22000000-0000-4000-8000-000000000007', '32000000-0000-4000-8000-0000000000b1', '0b000000-0000-4000-8000-00000000000b', '2026-11-03', 'dinner', '42000000-0000-4000-8000-0000000000b1', 4, 'cooked', 0),
  ('22000000-0000-4000-8000-000000000008', '32000000-0000-4000-8000-0000000000b1', '0b000000-0000-4000-8000-00000000000b', '2026-11-04', 'dinner', '42000000-0000-4000-8000-0000000000b1', 4, 'cooked', 0);

create temp table __t_orders (name text primary key, id uuid) on commit drop;
grant all on __t_orders to authenticated, service_role;
create function public.__t_order(p_name text) returns uuid
language sql stable as $$ select id from __t_orders where name = p_name $$;
grant execute on function public.__t_order(text) to authenticated, anon, service_role;

-- ---------------------------------------------------------------------------------------
-- Shape
-- ---------------------------------------------------------------------------------------

select ok((select relrowsecurity from pg_class where oid = 'public.orders'::regclass), 'orders has RLS enabled');
select policies_are('public', 'orders', array['orders: members read', 'orders: members update'], 'orders has a read and an update policy, and none for insert or delete');
select is((select array_agg(e.enumlabel::text order by e.enumsortorder) from pg_enum e where e.enumtypid = 'public.orders_status'::regtype), array['confirmed', 'picked_up', 'delivered', 'cancelled'], 'orders_status holds the four statuses of docs/02');
select ok(exists (select 1 from pg_constraint where conname = 'orders_run_key' and contype = 'u' and conrelid = 'public.orders'::regclass), 'one order per run: orders is unique on run_id');

select ok(has_table_privilege('authenticated', 'public.orders', 'SELECT'), 'authenticated can read orders');
select ok(not has_table_privilege('authenticated', 'public.orders', 'INSERT'), 'authenticated cannot insert orders');
select ok(not has_table_privilege('authenticated', 'public.orders', 'DELETE'), 'authenticated cannot delete orders');
select ok(not has_table_privilege('anon', 'public.orders', 'SELECT'), 'anon cannot read orders');
select ok(
  (select bool_and(has_column_privilege('authenticated', 'public.orders', c, 'UPDATE'))
     from unnest(array['modality', 'slot_start', 'slot_end', 'total_usd', 'retailer_order_id', 'notes', 'status']) c),
  'clients can correct the modality, window, total, order number, notes and status'
);
select ok(
  not (select bool_or(has_column_privilege('authenticated', 'public.orders', c, 'UPDATE'))
         from unnest(array['id', 'household_id', 'run_id', 'retailer', 'confirmed_by', 'confirmed_at', 'raw', 'created_at']) c),
  'and nothing else: not the run, household, retailer, who confirmed, when, or the Tier 3 details'
);
select ok(not has_function_privilege('anon', 'public.confirm_order(uuid, numeric, public.retailer_connections_modality, timestamptz, timestamptz, text, text)', 'EXECUTE'), 'anon cannot confirm an order');
select ok(has_function_privilege('authenticated', 'public.confirm_order(uuid, numeric, public.retailer_connections_modality, timestamptz, timestamptz, text, text)', 'EXECUTE'), 'authenticated can confirm an order');

select ok((select coalesce(c.reloptions::text, '') like '%security_invoker=true%' from pg_class c where c.oid = 'public.v_meals_cooked_weekly'::regclass), 'v_meals_cooked_weekly is security_invoker');
select ok((select coalesce(c.reloptions::text, '') like '%security_invoker=true%' from pg_class c where c.oid = 'public.v_spend_weekly_by_store'::regclass), 'v_spend_weekly_by_store is security_invoker');
select ok((select coalesce(c.reloptions::text, '') like '%security_invoker=true%' from pg_class c where c.oid = 'public.v_most_bought_products'::regclass), 'v_most_bought_products is security_invoker');
select ok(
  not has_table_privilege('anon', 'public.v_meals_cooked_weekly', 'SELECT')
  and not has_table_privilege('anon', 'public.v_spend_weekly_by_store', 'SELECT')
  and not has_table_privilege('anon', 'public.v_most_bought_products', 'SELECT'),
  'anon reads none of the views'
);
select ok(
  has_table_privilege('authenticated', 'public.v_meals_cooked_weekly', 'SELECT')
  and has_table_privilege('authenticated', 'public.v_spend_weekly_by_store', 'SELECT')
  and has_table_privilege('authenticated', 'public.v_most_bought_products', 'SELECT'),
  'authenticated reads all three'
);
-- Kroger terms (R21): no product price history. The only amount orders keeps is the total, and
-- the views carry totals and counts, never a per-product amount.
select is(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public'
      and table_name in ('orders', 'v_meals_cooked_weekly', 'v_spend_weekly_by_store', 'v_most_bought_products')
      and column_name ~* 'price'),
  0,
  'no column of orders or the views is a price'
);
select is(public.history_time_zone('0a000000-0000-4000-8000-00000000000a'), 'America/Los_Angeles', 'weeks are cut in the launch zone until households carry their own');

-- ---------------------------------------------------------------------------------------
-- confirm_order as alice
-- ---------------------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}';
set local role authenticated;

insert into __t_orders (name, id) values (
  'a1',
  public.confirm_order('f2000000-0000-4000-8000-0000000000a1', 100.00)
);
select isnt(public.__t_order('a1'), null, 'alice confirms the order for her ready run and gets its id');
select is((select count(*)::int from public.orders where run_id = 'f2000000-0000-4000-8000-0000000000a1'), 1, 'one order row exists for the run');

select throws_ok($$ select public.confirm_order('f2000000-0000-4000-8000-0000000000a1', 100.00) $$, 'P0001', 'already_confirmed', 'confirming the same run twice is refused with a clear error');
select throws_ok($$ select public.confirm_order('f2000000-0000-4000-8000-0000000000a1', 50.00, 'delivery') $$, 'P0001', 'already_confirmed', 'a second attempt with other values is refused too');
select throws_ok($$ select public.confirm_order('f2000000-0000-4000-8000-0000000000b1', 40.00) $$, 'P0001', 'run_not_found', 'alice cannot confirm an order for B''s run');
select throws_ok($$ select public.confirm_order('f2000000-0000-4000-8000-0000000000a4', 10.00) $$, 'P0001', 'run_not_confirmable', 'a queued run cannot be confirmed');
select throws_ok($$ select public.confirm_order('f2000000-0000-4000-8000-0000000000a5', 12.00) $$, 'P0001', 'run_not_confirmable', 'a cart nobody approved cannot be confirmed');
-- The next four runs ARE approved, so only their status can refuse them: the queued run above is
-- also unapproved, and the approval check alone would have refused it.
select throws_ok($$ select public.confirm_order('f2000000-0000-4000-8000-0000000000a9', 14.00) $$, 'P0001', 'run_not_confirmable', 'an approved run that failed cannot be confirmed');
select throws_ok($$ select public.confirm_order('f2000000-0000-4000-8000-0000000000aa', 15.00) $$, 'P0001', 'run_not_confirmable', 'an approved run that was cancelled cannot be confirmed');
select throws_ok($$ select public.confirm_order('f2000000-0000-4000-8000-0000000000ab', 16.00) $$, 'P0001', 'run_not_confirmable', 'an approved run still running (the push) cannot be confirmed');
select throws_ok($$ select public.confirm_order('f2000000-0000-4000-8000-0000000000ac', 17.00) $$, 'P0001', 'run_not_confirmable', 'an approved run that is checking out cannot be confirmed yet');
select throws_ok($$ select public.confirm_order('99999999-9999-4999-8999-999999999999', 12.00) $$, 'P0001', 'run_not_found', 'a run that does not exist is not found');
select throws_ok($$ select public.confirm_order('f2000000-0000-4000-8000-0000000000a8', -1.00) $$, 'P0001', 'invalid_total', 'a negative total is refused');
select throws_ok($$ select public.confirm_order('f2000000-0000-4000-8000-0000000000a8', null) $$, 'P0001', 'invalid_total', 'a missing total is refused');
select throws_ok($$ select public.confirm_order('f2000000-0000-4000-8000-0000000000a8', 100000.01) $$, 'P0001', 'invalid_total', 'an absurd total is refused');
select throws_ok($$ select public.confirm_order('f2000000-0000-4000-8000-0000000000a8', 5.00, null, '2026-11-04 10:00-08', '2026-11-04 09:00-08') $$, 'P0001', 'invalid_window', 'a window that ends before it starts is refused');
select throws_ok($$ select public.confirm_order('f2000000-0000-4000-8000-0000000000a8', 5.00, null, null, '2026-11-04 09:00-08') $$, 'P0001', 'invalid_window', 'a window with an end and no start is refused');
select throws_ok($$ select public.confirm_order('f2000000-0000-4000-8000-0000000000a8', 5.00, null, '2026-11-04 09:00-08', '2026-11-05 10:00-08') $$, 'P0001', 'invalid_window', 'a window longer than a day is refused');
select is((select count(*)::int from public.orders where run_id = 'f2000000-0000-4000-8000-0000000000a8'), 0, 'none of the refusals left an order behind');

-- With a window, a delivery modality, an order number and notes. Redmond is a delivery connection.
insert into __t_orders (name, id) values (
  'a2',
  public.confirm_order(
    'f2000000-0000-4000-8000-0000000000a2', 55.50, 'delivery',
    '2026-11-04 16:00-08', '2026-11-04 17:00-08', '  KRG-0042  ', 'Left at the side door'
  )
);
-- Checked out (a Tier 3 run) can be confirmed too; it becomes a cancelled order below.
insert into __t_orders (name, id) values ('a6', public.confirm_order('f2000000-0000-4000-8000-0000000000a6', 999.00));
-- The modality defaults to the run's connection: a1 shopped at a pickup connection, and ad at the
-- Redmond connection, which is a delivery one. ad is confirmed with no modality at all.
insert into __t_orders (name, id) values ('ad', public.confirm_order('f2000000-0000-4000-8000-0000000000ad', 33.00));
reset role;

select is((select status::text from public.orders where id = public.__t_order('a1')), 'confirmed', 'the order is confirmed');
select is((select total_usd from public.orders where id = public.__t_order('a1')), 100.00::numeric, 'total_usd is the value entered');
select is((select confirmed_by from public.orders where id = public.__t_order('a1')), 'a1111111-1111-4111-8111-111111111111'::uuid, 'confirmed_by is the caller');
select is((select run_id from public.orders where id = public.__t_order('a1')), 'f2000000-0000-4000-8000-0000000000a1'::uuid, 'run_id points at the run');
select is((select household_id from public.orders where id = public.__t_order('a1')), '0a000000-0000-4000-8000-00000000000a'::uuid, 'the household comes from the run');
select is((select retailer::text from public.orders where id = public.__t_order('a1')), 'kroger', 'the retailer comes from the run');
select is((select modality::text from public.orders where id = public.__t_order('a1')), 'pickup', 'the modality defaults to the connection''s');
select is((select modality::text from public.orders where id = public.__t_order('ad')), 'delivery', 'and to delivery when the run shopped at a delivery connection');
delete from public.orders where id = public.__t_order('ad');
select is((select slot_start from public.orders where id = public.__t_order('a1')), null, 'no window was entered');
select isnt((select confirmed_at from public.orders where id = public.__t_order('a1')), null, 'confirmed_at is stamped');

select is((select modality::text from public.orders where id = public.__t_order('a2')), 'delivery', 'an explicit modality wins');
select is((select slot_start from public.orders where id = public.__t_order('a2')), '2026-11-04 16:00-08'::timestamptz, 'the window start is kept');
select is((select slot_end from public.orders where id = public.__t_order('a2')), '2026-11-04 17:00-08'::timestamptz, 'the window end is kept');
select is((select retailer_order_id from public.orders where id = public.__t_order('a2')), 'KRG-0042', 'the order number is trimmed');
select is((select notes from public.orders where id = public.__t_order('a2')), 'Left at the side door', 'notes are kept');
select is((select count(*)::int from public.orders where run_id = 'f2000000-0000-4000-8000-0000000000a6'), 1, 'a checked-out run can be confirmed');

-- Not signed in, and signed in without a household.
set local request.jwt.claims = '{"role": "authenticated"}';
set local role authenticated;
select throws_ok($$ select public.confirm_order('f2000000-0000-4000-8000-0000000000a8', 5.00) $$, 'P0001', 'not_authenticated', 'no user, no order');
reset role;

set local request.jwt.claims = '{"sub": "d4444444-4444-4444-8444-444444444444", "role": "authenticated"}';
set local role authenticated;
select throws_ok($$ select public.confirm_order('f2000000-0000-4000-8000-0000000000a8', 5.00) $$, 'P0001', 'run_not_found', 'dave, in no household, cannot confirm an order');
select is((select count(*)::int from public.orders), 0, 'dave reads no orders');
reset role;

-- Erin is a member of a household that was soft-deleted. Her run is cart_ready and approved, so
-- only the deleted household can refuse it.
set local request.jwt.claims = '{"sub": "e5555555-5555-4555-8555-555555555555", "role": "authenticated"}';
set local role authenticated;
select throws_ok($$ select public.confirm_order('f2000000-0000-4000-8000-0000000000c1', 25.00) $$, 'P0001', 'run_not_found', 'a member of a soft-deleted household cannot confirm one of its orders');
reset role;

-- Carol is a plain member: she may confirm too, and the run is the one alice's order is for.
set local request.jwt.claims = '{"sub": "c3333333-3333-4333-8333-333333333333", "role": "authenticated"}';
set local role authenticated;
select throws_ok($$ select public.confirm_order('f2000000-0000-4000-8000-0000000000a1', 1.00) $$, 'P0001', 'already_confirmed', 'carol sees the run already has an order');
select lives_ok($$ select public.confirm_order('f2000000-0000-4000-8000-0000000000a8', 5.00) $$, 'a plain member can confirm an order');
reset role;
select is((select confirmed_by from public.orders where run_id = 'f2000000-0000-4000-8000-0000000000a8'), 'c3333333-3333-4333-8333-333333333333'::uuid, 'and is recorded as the one who confirmed it');
delete from public.orders where run_id = 'f2000000-0000-4000-8000-0000000000a8';

-- ---------------------------------------------------------------------------------------
-- Direct writes
-- ---------------------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}';
set local role authenticated;
select throws_ok($$ insert into public.orders (household_id, run_id, retailer, modality, total_usd) values ('0a000000-0000-4000-8000-00000000000a', 'f2000000-0000-4000-8000-0000000000a8', 'kroger', 'pickup', 5) $$, '42501', null, 'alice cannot insert an order directly');
select throws_ok($$ delete from public.orders where id = public.__t_order('a1') $$, '42501', null, 'alice cannot delete an order');
select throws_ok($$ update public.orders set run_id = 'f2000000-0000-4000-8000-0000000000a8' where id = public.__t_order('a1') $$, '42501', null, 'alice cannot move an order to another run');
select throws_ok($$ update public.orders set household_id = '0b000000-0000-4000-8000-00000000000b' where id = public.__t_order('a1') $$, '42501', null, 'alice cannot move an order to another household');
select throws_ok($$ update public.orders set confirmed_by = 'c3333333-3333-4333-8333-333333333333' where id = public.__t_order('a1') $$, '42501', null, 'alice cannot change who confirmed an order');
select throws_ok($$ update public.orders set raw = '{"x": 1}' where id = public.__t_order('a1') $$, '42501', null, 'alice cannot write the Tier 3 details');
select is(public.__t_affected($$ update public.orders set notes = 'Pickup was easy', slot_start = '2026-11-02 17:00-08', slot_end = '2026-11-02 18:00-08' where id = public.__t_order('a1') $$), 1::bigint, 'alice adds a pickup window and notes later');
select throws_ok($$ update public.orders set total_usd = -5 where id = public.__t_order('a1') $$, '23514', null, 'a correction still has to be a valid total');
select throws_ok($$ update public.orders set slot_end = slot_start where id = public.__t_order('a1') $$, '23514', null, 'and a valid window');
reset role;
select is((select notes from public.orders where id = public.__t_order('a1')), 'Pickup was easy', 'the correction was saved');

-- The service role (WS10 records a Tier 3 order from the confirmation page) writes directly, and
-- the sync trigger puts the run's household and retailer on the row whatever it sends.
set local request.jwt.claims = '{"role": "service_role"}';
set local role service_role;
insert into public.orders (id, household_id, run_id, retailer, modality, total_usd, raw)
values ('52000000-0000-4000-8000-0000000000a8', '0b000000-0000-4000-8000-00000000000b', 'f2000000-0000-4000-8000-0000000000a8', 'safeway', 'pickup', 5.00, '{"confirmation": "T3-1"}');
select is((select household_id from public.orders where id = '52000000-0000-4000-8000-0000000000a8'), '0a000000-0000-4000-8000-00000000000a'::uuid, 'the household comes from the run, whatever the writer sent');
select is((select retailer::text from public.orders where id = '52000000-0000-4000-8000-0000000000a8'), 'kroger', 'and so does the retailer');
select is((select confirmed_by from public.orders where id = '52000000-0000-4000-8000-0000000000a8'), null, 'a worker-written order has no confirming member');
select throws_ok($$ insert into public.orders (household_id, run_id, retailer, modality, total_usd) values ('0a000000-0000-4000-8000-00000000000a', '99999999-9999-4999-8999-999999999999', 'kroger', 'pickup', 5) $$, 'P0001', 'run_not_found', 'an order for a run that does not exist is refused');
select throws_ok($$ insert into public.orders (household_id, run_id, retailer, modality, total_usd) values ('0a000000-0000-4000-8000-00000000000a', 'f2000000-0000-4000-8000-0000000000a8', 'kroger', 'pickup', 6) $$, '23505', null, 'a second order for a run is refused by the unique key');
select throws_ok($$ insert into public.orders (household_id, run_id, retailer, modality, total_usd) values ('0a000000-0000-4000-8000-00000000000a', 'f2000000-0000-4000-8000-0000000000a5', 'kroger', 'pickup', -1) $$, '23514', null, 'a negative total is refused by the table too');
reset role;
delete from public.orders where id = '52000000-0000-4000-8000-0000000000a8';

-- Fixed times and totals for the view tests. Week one is Monday 2026-11-02, week two 2026-11-09.
update public.orders set confirmed_at = '2026-11-02 18:00-08' where id = public.__t_order('a1');
update public.orders set confirmed_at = '2026-11-04 12:00-08' where id = public.__t_order('a2');
update public.orders set confirmed_at = '2026-11-03 09:00-08', status = 'cancelled' where id = public.__t_order('a6');
insert into public.orders (id, household_id, run_id, retailer, modality, total_usd, confirmed_by, confirmed_at) values
  ('52000000-0000-4000-8000-0000000000a3', '0a000000-0000-4000-8000-00000000000a', 'f2000000-0000-4000-8000-0000000000a3', 'kroger', 'pickup', 80.25, 'a1111111-1111-4111-8111-111111111111', '2026-11-09 09:00-08'),
  -- Sunday evening in Los Angeles is Monday in UTC: it belongs to week one.
  ('52000000-0000-4000-8000-0000000000a7', '0a000000-0000-4000-8000-00000000000a', 'f2000000-0000-4000-8000-0000000000a7', 'kroger', 'delivery', 10.00, 'c3333333-3333-4333-8333-333333333333', '2026-11-09 04:00+00'),
  ('52000000-0000-4000-8000-0000000000b1', '0b000000-0000-4000-8000-00000000000b', 'f2000000-0000-4000-8000-0000000000b1', 'kroger', 'pickup', 40.00, 'b2222222-2222-4222-8222-222222222222', '2026-11-03 10:00-08'),
  -- An order on the never-approved run ae, as a service-role writer could leave one. It is a
  -- $0.00 order in week two at Duvall, so it changes that row's order count and nothing else.
  ('52000000-0000-4000-8000-0000000000ae', '0a000000-0000-4000-8000-00000000000a', 'f2000000-0000-4000-8000-0000000000ae', 'kroger', 'pickup', 0.00, null, '2026-11-10 09:00-08');

-- ---------------------------------------------------------------------------------------
-- RLS: household A versus household B
-- ---------------------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "c3333333-3333-4333-8333-333333333333", "role": "authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.orders where household_id = '0a000000-0000-4000-8000-00000000000a'), 6, 'carol reads all six of A''s orders, including the ones alice confirmed');
select is((select count(*)::int from public.orders where household_id = '0b000000-0000-4000-8000-00000000000b'), 0, 'carol reads none of B''s orders');
select is(public.__t_affected($$ update public.orders set notes = 'carol was here' where id = public.__t_order('a2') $$), 1::bigint, 'carol edits A''s order notes');
reset role;

set local request.jwt.claims = '{"sub": "b2222222-2222-4222-8222-222222222222", "role": "authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.orders where household_id = '0a000000-0000-4000-8000-00000000000a'), 0, 'bob reads none of A''s orders');
select is((select count(*)::int from public.orders where id = public.__t_order('a1')), 0, 'bob cannot find A''s order by id');
select is((select count(*)::int from public.orders), 1, 'bob reads his own order');
select is(public.__t_affected($$ update public.orders set notes = 'bob was here' where id = public.__t_order('a1') $$), 0::bigint, 'bob cannot update A''s order');
select is(public.__t_affected($$ update public.orders set status = 'cancelled' where household_id = '0a000000-0000-4000-8000-00000000000a' $$), 0::bigint, 'and cannot cancel any of them');
select throws_ok($$ select public.confirm_order('f2000000-0000-4000-8000-0000000000a3', 80.25) $$, 'P0001', 'run_not_found', 'bob cannot confirm an order for A''s run');
select is((select count(*)::int from public.shopping_runs where id = 'f2000000-0000-4000-8000-0000000000a3'), 0, 'bob cannot see A''s run either');
reset role;
select is((select notes from public.orders where id = public.__t_order('a1')), 'Pickup was easy', 'A''s order is as alice left it');

-- ---------------------------------------------------------------------------------------
-- v_spend_weekly_by_store (alice's household: three stores-weeks from four live orders)
-- ---------------------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "c3333333-3333-4333-8333-333333333333", "role": "authenticated"}';
set local role authenticated;
select is(
  (select string_agg(week_start::text || '|' || store_name || '|' || total_usd::text || '|' || order_count::text, ';' order by week_start, store_name)
     from public.v_spend_weekly_by_store where household_id = '0a000000-0000-4000-8000-00000000000a'),
  '2026-11-02|Mock QFC Duvall|100.00|1;2026-11-02|Mock QFC Redmond|65.50|2;2026-11-09|Mock QFC Duvall|80.25|2',
  'one row per week and store, with the summed totals'
);
select is(
  (select count(*)::int from public.v_spend_weekly_by_store where household_id = '0a000000-0000-4000-8000-00000000000a'),
  (select count(distinct (week_start, retailer, store_name))::int from public.v_spend_weekly_by_store where household_id = '0a000000-0000-4000-8000-00000000000a'),
  'no (week, store) appears twice'
);
select is(
  (select sum(total_usd) from public.v_spend_weekly_by_store where household_id = '0a000000-0000-4000-8000-00000000000a'),
  (select sum(total_usd) from public.orders where household_id = '0a000000-0000-4000-8000-00000000000a' and status <> 'cancelled'),
  'the view''s total is the sum of the confirmed orders'
);
select is(
  (select total_usd from public.v_spend_weekly_by_store where household_id = '0a000000-0000-4000-8000-00000000000a' and week_start = '2026-11-02' and store_name = 'Mock QFC Redmond'),
  65.50::numeric,
  'a Sunday evening order in Los Angeles counts in the week that ends that day'
);
select is(
  (select count(*)::int from public.v_spend_weekly_by_store where household_id = '0a000000-0000-4000-8000-00000000000a' and total_usd >= 999),
  0,
  'a cancelled order is left out'
);
select is((select count(*)::int from public.v_spend_weekly_by_store where household_id = '0b000000-0000-4000-8000-00000000000b'), 0, 'carol sees no spend of B''s');
reset role;

set local request.jwt.claims = '{"sub": "b2222222-2222-4222-8222-222222222222", "role": "authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.v_spend_weekly_by_store), 1, 'bob sees only his own spend row');
select is((select total_usd from public.v_spend_weekly_by_store), 40.00::numeric, 'and its total');
select is((select count(*)::int from public.v_spend_weekly_by_store where household_id = '0a000000-0000-4000-8000-00000000000a'), 0, 'bob sees none of A''s spend through the view');
reset role;

-- ---------------------------------------------------------------------------------------
-- v_meals_cooked_weekly
-- ---------------------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "c3333333-3333-4333-8333-333333333333", "role": "authenticated"}';
set local role authenticated;
select is((select cooked_count from public.v_meals_cooked_weekly where household_id = '0a000000-0000-4000-8000-00000000000a' and week_start = '2026-11-02'), 3, 'a plan with five entries, three cooked, has cooked_count 3');
select is((select cooked_count from public.v_meals_cooked_weekly where household_id = '0a000000-0000-4000-8000-00000000000a' and week_start = '2026-11-09'), 1, 'the next week has one');
select is((select count(*)::int from public.v_meals_cooked_weekly where household_id = '0a000000-0000-4000-8000-00000000000a'), 2, 'one row per week with something cooked');
select is((select jsonb_array_length(entries) from public.v_meals_cooked_weekly where household_id = '0a000000-0000-4000-8000-00000000000a' and week_start = '2026-11-02'), 3, 'entries lists the cooked meals and nothing else');
select is(
  (select string_agg(x ->> 'date' || ' ' || (x ->> 'slot') || ' ' || (x ->> 'title'), '; ' order by ord)
     from public.v_meals_cooked_weekly v, jsonb_array_elements(v.entries) with ordinality as t(x, ord)
    where v.household_id = '0a000000-0000-4000-8000-00000000000a' and v.week_start = '2026-11-02'),
  '2026-11-02 dinner ws12 Green curry; 2026-11-03 dinner ws12 Lemon chicken; 2026-11-05 dinner ws12 Lemon chicken',
  'entries are oldest first, with the recipe title'
);
select is((select count(*)::int from public.v_meals_cooked_weekly where household_id = '0b000000-0000-4000-8000-00000000000b'), 0, 'carol sees none of B''s cooked meals');
reset role;

set local request.jwt.claims = '{"sub": "b2222222-2222-4222-8222-222222222222", "role": "authenticated"}';
set local role authenticated;
select is((select cooked_count from public.v_meals_cooked_weekly), 2, 'bob sees his own two cooked meals');
select is((select count(*)::int from public.v_meals_cooked_weekly where household_id = '0a000000-0000-4000-8000-00000000000a'), 0, 'and none of A''s');
reset role;

-- ---------------------------------------------------------------------------------------
-- v_most_bought_products
-- ---------------------------------------------------------------------------------------

set local request.jwt.claims = '{"sub": "c3333333-3333-4333-8333-333333333333", "role": "authenticated"}';
set local role authenticated;
select is(
  (select product_id from public.v_most_bought_products where household_id = '0a000000-0000-4000-8000-00000000000a' order by times_bought desc, last_bought_at desc limit 1),
  'P-ONION',
  'the onion, bought twice, ranks first by an explicit order (the view''s own order is checked below)'
);
select is((select times_bought from public.v_most_bought_products where household_id = '0a000000-0000-4000-8000-00000000000a' and store_id = 'MOCK0001' and product_id = 'P-ONION'), 2, 'the onion was on two confirmed orders (the cancelled one does not count)');
select is((select units_bought from public.v_most_bought_products where household_id = '0a000000-0000-4000-8000-00000000000a' and product_id = 'P-ONION'), 3::numeric, 'and 3 units were in the carts');
select is((select product_name from public.v_most_bought_products where household_id = '0a000000-0000-4000-8000-00000000000a' and product_id = 'P-ONION'), 'Harbor Fields Yellow Onions, 3 lb', 'the name is the latest the household saw');
select is((select store_name from public.v_most_bought_products where household_id = '0a000000-0000-4000-8000-00000000000a' and product_id = 'P-ONION'), 'Mock QFC Duvall', 'a row carries the name of the store it was bought at');
select is((select pinned from public.v_most_bought_products where household_id = '0a000000-0000-4000-8000-00000000000a' and product_id = 'P-ONION'), true, 'the pinned onion is pinned');
select is((select pinned from public.v_most_bought_products where household_id = '0a000000-0000-4000-8000-00000000000a' and store_id = 'MOCK0001' and product_id = 'P-MILK'), false, 'the unpinned milk is not');
select is((select pinned from public.v_most_bought_products where household_id = '0a000000-0000-4000-8000-00000000000a' and product_id = 'P-MILK2'), false, 'a product with no product_matches row is not pinned');
select is(
  (select ingredient_id from public.v_most_bought_products where household_id = '0a000000-0000-4000-8000-00000000000a' and product_id = 'P-FREE'),
  null,
  'a free-text line has no ingredient, so the app cannot pin it'
);
select is(
  (select ingredient_id from public.v_most_bought_products where household_id = '0a000000-0000-4000-8000-00000000000a' and product_id = 'P-ONION'),
  '12000000-0000-4000-8000-000000000001'::uuid,
  'a list line carries its ingredient, the key product_matches pins by'
);
select is((select count(*)::int from public.v_most_bought_products where household_id = '0a000000-0000-4000-8000-00000000000a' and product_id = 'P-EGGS'), 0, 'a line the store did not put in the cart (cart_qty 0) is not bought');
select is((select count(*)::int from public.v_most_bought_products where household_id = '0a000000-0000-4000-8000-00000000000a' and product_id = 'P-GONE'), 0, 'a line the person removed is not bought');
select is((select count(*)::int from public.v_most_bought_products where household_id = '0a000000-0000-4000-8000-00000000000a' and product_id = 'P-MILK'), 2, 'the same product at two stores is two rows (the pin key includes the store)');
select is((select times_bought from public.v_most_bought_products where household_id = '0a000000-0000-4000-8000-00000000000a' and store_id = 'MOCK0003' and product_id = 'P-MILK'), 1, 'the Redmond milk was bought once');
-- Pins are scoped to the store: the rice is pinned at Duvall and the same rice at Redmond is not.
select is((select pinned from public.v_most_bought_products where household_id = '0a000000-0000-4000-8000-00000000000a' and store_id = 'MOCK0001' and product_id = 'P-RICE'), true, 'the rice pinned at Duvall is pinned there');
select is((select pinned from public.v_most_bought_products where household_id = '0a000000-0000-4000-8000-00000000000a' and store_id = 'MOCK0003' and product_id = 'P-RICE'), false, 'and the same rice at Redmond is not: a pin belongs to one store');
-- A line on a run nobody approved is not bought, even on an order and with the cart holding it.
select is((select count(*)::int from public.v_most_bought_products where household_id = '0a000000-0000-4000-8000-00000000000a' and product_id = 'P-UNAPPR'), 0, 'a line on a run that was never approved is not bought');
-- The view's own order, read with no ORDER BY of ours: most times first, then the most recent.
-- Rows that tie on both keys read the same here, so the sequence is the same whichever of them
-- comes first. Without the view's ORDER BY the rows come out in group-key order and this fails.
select is(
  (select array_agg(times_bought::text || '@' || (last_bought_at at time zone 'UTC')::date::text)
     from public.v_most_bought_products where household_id = '0a000000-0000-4000-8000-00000000000a'),
  array['2@2026-11-09', '1@2026-11-09', '1@2026-11-04', '1@2026-11-04', '1@2026-11-03', '1@2026-11-03', '1@2026-11-03'],
  'the view lists the most bought first, then the most recent, in its own order'
);
select is((select count(*)::int from public.v_most_bought_products where household_id = '0b000000-0000-4000-8000-00000000000b'), 0, 'carol sees none of B''s products');
reset role;

set local request.jwt.claims = '{"sub": "b2222222-2222-4222-8222-222222222222", "role": "authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.v_most_bought_products), 1, 'bob sees his one product');
select is((select pinned from public.v_most_bought_products), false, 'and the pin of A''s household does not leak into it');
select is((select count(*)::int from public.v_most_bought_products where household_id = '0a000000-0000-4000-8000-00000000000a'), 0, 'bob sees none of A''s products through the view');
reset role;

-- Toggling the pin changes the view (acceptance 5). The app updates the match as the member.
set local request.jwt.claims = '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}';
set local role authenticated;
select is(
  public.__t_affected($$ update public.product_matches set pinned = true, chosen_by = 'user' where household_id = '0a000000-0000-4000-8000-00000000000a' and store_id = 'MOCK0001' and ingredient_id = '12000000-0000-4000-8000-000000000002' and product_id = 'P-MILK' $$),
  1::bigint,
  'alice pins the milk through product_matches'
);
select is((select pinned from public.v_most_bought_products where household_id = '0a000000-0000-4000-8000-00000000000a' and store_id = 'MOCK0001' and product_id = 'P-MILK'), true, 'and the view reflects it on the next read');
select is(
  public.__t_affected($$ update public.product_matches set pinned = false, chosen_by = 'user' where household_id = '0a000000-0000-4000-8000-00000000000a' and store_id = 'MOCK0001' and ingredient_id = '12000000-0000-4000-8000-000000000002' and product_id = 'P-MILK' $$),
  1::bigint,
  'alice unpins it'
);
select is((select pinned from public.v_most_bought_products where household_id = '0a000000-0000-4000-8000-00000000000a' and store_id = 'MOCK0001' and product_id = 'P-MILK'), false, 'and the view follows');
reset role;

-- ---------------------------------------------------------------------------------------
-- Deleting a household removes its orders
-- ---------------------------------------------------------------------------------------

select is((select count(*)::int from public.orders where household_id = '0b000000-0000-4000-8000-00000000000b'), 1, 'B has an order before it is deleted');
delete from public.households where id = '0b000000-0000-4000-8000-00000000000b';
select is((select count(*)::int from public.orders where household_id = '0b000000-0000-4000-8000-00000000000b'), 0, 'deleting household B removed its orders');
select is((select count(*)::int from public.orders where run_id = 'f2000000-0000-4000-8000-0000000000b1'), 0, 'and no order of its run is left');
select is((select count(*)::int from public.orders where household_id = '0a000000-0000-4000-8000-00000000000a'), 6, 'A''s orders are untouched');

select * from finish();

rollback;
