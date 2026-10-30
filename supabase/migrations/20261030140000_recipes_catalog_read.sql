-- Catalog reads (orchestrator, 2026-10-30).
--
-- WS02 left catalog recipes (visibility = 'catalog', household_id null) unreadable by clients,
-- since the catalog was planned for v2. The starter catalog (WS16) makes it v1. Every signed-in
-- member reads catalog recipes and their ingredient lines, so the planner can show a suggested
-- recipe's title (WS04 embeds `recipes` in its entry query), the picker can list the catalog, and
-- list aggregation (WS05) can read the lines.
--
-- Nothing else changes. The WS02 insert and update policies still require a household row, so no
-- client can write a catalog recipe or its lines; the seed (service role) is the only writer.
-- Soft-deleted catalog rows stay readable, like household rows, so a planned entry that points at
-- a retired recipe can still show its title. Pickers filter `deleted_at is null` as they do today.

create policy "recipes: catalog read" on public.recipes
  for select to authenticated
  using (visibility = 'catalog');

create policy "recipe_ingredients: catalog read" on public.recipe_ingredients
  for select to authenticated
  using (
    exists (
      select 1
      from public.recipes r
      where r.id = recipe_ingredients.recipe_id
        and r.visibility = 'catalog'
    )
  );

comment on table public.recipes is
  'A household''s recipes (WS02) and the starter catalog (WS16: visibility = catalog, household_id null). Catalog rows are readable by every member and written only by the seed.';
