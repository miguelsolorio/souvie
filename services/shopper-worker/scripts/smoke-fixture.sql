-- WS09 worker smoke fixture (CI only, against the local stack after `db reset`): one household,
-- one member, a twelve-line grocery list built from the seeded ontology, and a connection to the
-- mock store (auth_type none, store MOCK0001). The worker runs with WORKER_RETAILER_MODE=mock.
-- Ids are fixed and unlike any other fixture's.

insert into auth.users (id, email) values
  ('c9999999-9999-4999-8999-999999999999', 'ws09-smoke@example.test');

insert into public.households (id, name, created_by) values
  ('0c000000-0000-4000-8000-0000000000c9', 'WS09 Smoke', 'c9999999-9999-4999-8999-999999999999');

insert into public.household_members (household_id, user_id, role) values
  ('0c000000-0000-4000-8000-0000000000c9', 'c9999999-9999-4999-8999-999999999999', 'owner');

update public.profiles set preferences = '{"allergies": ["peanut"]}'::jsonb
 where user_id = 'c9999999-9999-4999-8999-999999999999';

insert into public.grocery_lists (id, household_id, name) values
  ('9c000000-0000-4000-8000-0000000000c9', '0c000000-0000-4000-8000-0000000000c9', 'WS09 smoke week');

insert into public.grocery_list_items (list_id, household_id, ingredient_id, display_name, qty, unit, section, position)
select '9c000000-0000-4000-8000-0000000000c9', '0c000000-0000-4000-8000-0000000000c9',
       (select i.id from public.ingredients i where i.name = l.name),
       l.display_name, l.qty, l.unit, l.section, l.position
  from (values
    ('yellow onion', 'Yellow onions', 3, 'each', 'produce', 0),
    ('garlic', 'Garlic', 1, 'head', 'produce', 1),
    ('chicken thigh', 'Boneless skinless chicken thighs', 1.5, 'lb', 'meat', 2),
    ('milk', 'Whole milk', 1, 'gallon', 'dairy', 3),
    ('egg', 'Large eggs', 12, 'each', 'eggs', 4),
    ('unsalted butter', 'Unsalted butter', 8, 'oz', 'dairy', 5),
    ('spinach', 'Baby spinach', 1, 'bag', 'produce', 6),
    ('diced tomatoes', 'Diced tomatoes', 2, 'can', 'canned', 7),
    ('chicken broth', 'Chicken broth', 4, 'cup', 'pantry', 8),
    ('penne', 'Penne', 16, 'oz', 'pantry', 9),
    ('salmon fillet', 'Salmon fillets', 1.5, 'lb', 'seafood', 10),
    ('oat milk', 'Oat milk', 8, 'cup', 'dairy', 11)
  ) as l(name, display_name, qty, unit, section, position);

insert into public.retailer_connections (
  id, household_id, user_id, retailer, auth_type, store_id, store_name, modality, status
) values (
  '7c000000-0000-4000-8000-0000000000c9', '0c000000-0000-4000-8000-0000000000c9',
  'c9999999-9999-4999-8999-999999999999', 'kroger', 'none', 'MOCK0001', 'Mock QFC Duvall',
  'pickup', 'active'
);
