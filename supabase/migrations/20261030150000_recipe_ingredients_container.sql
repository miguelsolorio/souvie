-- Container count and word on an ingredient line (orchestrator, 2026-10-30, CCR5 from WS03).
--
-- "2 (14 oz) cans diced tomatoes" parses to qty 28, unit oz. Aggregation (WS05) and the shopping
-- agent (WS09) also need to know that it was 2 cans, otherwise the pack table rounds 28 oz of
-- canned tomatoes to two 14.5 oz cans when the recipe meant two 14 oz cans, and "1 (28 oz) can"
-- double-buys. Both columns are nullable: the parser (WS03) fills them when a line names a
-- container with a size, and every other line leaves them null. qty and unit stay the total.

alter table public.recipe_ingredients
  add column container_count integer,
  add column container text,
  add constraint recipe_ingredients_container_count_positive
    check (container_count is null or container_count > 0),
  add constraint recipe_ingredients_container_length
    check (container is null or char_length(btrim(container)) between 1 and 40),
  add constraint recipe_ingredients_container_pair
    check (container_count is null or container is not null);

comment on column public.recipe_ingredients.container_count is
  'Containers the line names when it gives a size: "2 (14 oz) cans" is 2. Null when the line has no container.';
comment on column public.recipe_ingredients.container is
  'The container word (can, jar, package, bag). Null when the line has no container. qty and unit hold the total contents.';

-- Clients may write the two columns like the other parsed fields; recipe_id stays fixed.
grant insert (container_count, container), update (container_count, container)
  on public.recipe_ingredients to authenticated;
