-- WS02 follow-up (2026-10-31): one live recipe per link in a household.
--
-- Adding the same recipe twice must not make a second copy. The recipe-import function and the
-- app look for an existing recipe first (packages/recipe-import/src/dedupe.ts); this migration is
-- the backstop for the case where two saves race, or a client skips the check:
--
--   recipes.source_url_normalized   the link with its host lowercased, no fragment, no tracking
--                                   parameters and no trailing slash. Filled by a trigger from
--                                   source_url, so no client can set it (it is in no column grant).
--   a partial unique index          at most one LIVE recipe per (household, normalized link).
--                                   Soft-deleted recipes free their link; catalog rows
--                                   (household_id null) and recipes without a link are not covered.
--
-- normalize_source_url is the SQL half of normalizeSourceUrl in
-- packages/recipe-import/src/dedupe.ts. The two must agree: supabase/functions/recipe-import/
-- normalize-sql.test.ts runs a shared list of links through both. The rules, in order:
--   1. trim, then drop everything from the first "#"
--   2. split into scheme, authority, path and query; lowercase the scheme and the authority (host)
--   3. drop query parameters named utm_*, fbclid, gclid, dclid, msclkid, mc_cid, mc_eid, igshid,
--      igsh, ref_src, _ga or oly_* (the same list cleanSourceUrl strips on import), and empty ones
--   4. strip trailing slashes from the path; keep the case of the path and the order of what is
--      left of the query
--
-- Policies: none added or changed. recipes keeps exactly the four it has (supabase/tests/
-- 002_rls_recipes.sql pins them), and the new column is readable under the existing table-level
-- select grant but in no insert or update grant.

alter table public.recipes add column source_url_normalized text;

comment on column public.recipes.source_url_normalized is
  'source_url as normalize_source_url() reads it. Set by trigger; the unique index on it keeps one live recipe per link in a household.';

create function public.normalize_source_url(raw text) returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  parts text[];
  kept text;
begin
  if raw is null then
    return null;
  end if;

  parts := regexp_match(
    btrim(raw),
    '^(https?)://([^/?#[:space:]]*)([^?#[:space:]]*)(?:\?([^#[:space:]]*))?(?:#.*)?$',
    'i'
  );
  if parts is null then
    return null;
  end if;

  select string_agg(p, '&' order by ord)
    into kept
    from unnest(string_to_array(parts[4], '&')) with ordinality as t(p, ord)
   where p <> ''
     and split_part(p, '=', 1) !~* '^(utm_[a-z_]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|igsh|ref_src|_ga|oly_[a-z_]+)$';

  return lower(parts[1]) || '://' || lower(parts[2])
    || regexp_replace(parts[3], '/+$', '')
    || case when kept is null then '' else '?' || kept end;
end;
$$;

comment on function public.normalize_source_url(text) is
  'The comparison form of a recipe link. Mirrors normalizeSourceUrl in packages/recipe-import/src/dedupe.ts.';

create function public.recipes_set_source_url_normalized() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.source_url_normalized := public.normalize_source_url(new.source_url);
  return new;
end;
$$;

-- Only an insert or a change to source_url can alter the key. Clients cannot update source_url
-- at all (it is attribution), so in practice this runs on insert.
create trigger recipes_set_source_url_normalized
  before insert or update of source_url on public.recipes
  for each row execute function public.recipes_set_source_url_normalized();

-- Existing rows. Recipes already in the database may include the same link more than once in one
-- household (nothing stopped it until now). The oldest live copy of each link takes the key and
-- the others keep a null key, so the index below can be built without deleting anyone's recipe.
-- They stay exactly as they are, and the person can delete the extras. Soft-deleted rows all get
-- their key: the index does not cover them. updated_at is left alone.
alter table public.recipes disable trigger recipes_set_updated_at;

with keyed as (
  select
    id,
    deleted_at,
    household_id,
    public.normalize_source_url(source_url) as key,
    row_number() over (
      partition by household_id, public.normalize_source_url(source_url), (deleted_at is null)
      order by created_at, id
    ) as rn
  from public.recipes
  where source_url is not null
)
update public.recipes r
   set source_url_normalized = keyed.key
  from keyed
 where r.id = keyed.id
   and keyed.key is not null
   and (keyed.deleted_at is not null or keyed.household_id is null or keyed.rn = 1);

alter table public.recipes enable trigger recipes_set_updated_at;

create unique index recipes_household_source_url_normalized_uq
  on public.recipes (household_id, source_url_normalized)
  where deleted_at is null
    and household_id is not null
    and source_url_normalized is not null;

comment on index public.recipes_household_source_url_normalized_uq is
  'One live recipe per link in a household. A soft-deleted recipe frees its link.';
