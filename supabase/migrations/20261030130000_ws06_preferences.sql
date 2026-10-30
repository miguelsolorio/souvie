-- WS06: onboarding progress, the taste embedding, and the Costco answer on profiles.
-- docs/02-data-model.md §Identity (profiles) and §Migration ownership, order 10.
--
-- What changes:
--   * profiles gains onboarding_step, taste_embedding, and costco_member. profiles.preferences
--     already exists (WS01 created it as jsonb not null default '{}'), so it is only given a
--     CHECK constraint here.
--   * Client privileges on profiles become column level, so a person can edit their own
--     preferences and progress but cannot write the embedding the suggest function builds. It
--     was table level (select, insert, update) from WS01. Reads stay table level.
--   * The HNSW index on recipes.embedding that the WS06 brief asks for already exists as
--     recipes_embedding_hnsw_idx (WS02's recipes migration), so no second index is created.
--
-- A later migration that adds a profiles column grants insert or update on it explicitly, and
-- only if clients should write it. supabase/tests/ws06_preferences.sql pins the lists below.

-- ---------------------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------------------

alter table public.profiles
  -- The number of the last onboarding screen the person completed, 0 to 8. 8 means done.
  add column onboarding_step smallint not null default 0,
  -- Built by the suggest function (voyage-3, 1024 dimensions) from preferences and liked
  -- recipes. Never client-writable.
  add column taste_embedding extensions.vector(1024),
  -- Asked on onboarding screen 7. Null until answered. Costco on Instacart is members-only, so
  -- WS08 and WS10 route on this.
  add column costco_member boolean;

alter table public.profiles
  add constraint profiles_onboarding_step_range check (onboarding_step between 0 and 8);

comment on column public.profiles.onboarding_step is
  'Last onboarding screen completed, 0 to 8 (WS06). 8 means onboarding is done.';
comment on column public.profiles.taste_embedding is
  'voyage-3 embedding of the person''s tastes, built by the suggest function. Service role writes.';
comment on column public.profiles.costco_member is
  'Answer to "Do you have a Costco membership?" Null until asked (WS06).';

-- ---------------------------------------------------------------------------------------
-- preferences must be an object, small, and use the closed allergen and diet vocabularies
-- ---------------------------------------------------------------------------------------
-- core.ProfilePreferences (packages/core/src/preferences.ts) is the writer and rejects the same
-- values. This repeats the two lists that matter for safety: an allergen the filters do not know
-- would silently filter nothing, so a client that skips the app still cannot store one. Keep the
-- lists in step with ALLERGENS and DIETS; the WS06 tests compare them.

alter table public.profiles
  add constraint profiles_preferences_valid check (
    jsonb_typeof(preferences) = 'object'
    and octet_length(preferences::text) <= 16384
    and (
      not (preferences ? 'allergies')
      or (
        jsonb_typeof(preferences -> 'allergies') = 'array'
        and (preferences -> 'allergies') <@ '["peanut","tree_nut","milk","egg","wheat","soy","fish","shellfish","sesame"]'::jsonb
      )
    )
    and (
      not (preferences ? 'diets')
      or (
        jsonb_typeof(preferences -> 'diets') = 'array'
        and (preferences -> 'diets') <@ '["omnivore","vegetarian","vegan","pescatarian","halal","kosher","gluten_free","dairy_free","low_carb","keto","paleo"]'::jsonb
      )
    )
  );

-- ---------------------------------------------------------------------------------------
-- Column-level client privileges on profiles
-- ---------------------------------------------------------------------------------------
-- WS01 granted select, insert, update at table level. Take insert and update back and grant them
-- by column. taste_embedding, created_at, and updated_at (a trigger keeps it current) are never
-- client-written. user_id is insertable (the row policy then requires it to be the caller's own)
-- but not updatable: a profile never changes hands.

revoke insert, update on public.profiles from authenticated;

grant insert (user_id, display_name, avatar_url, preferences, onboarding_step, costco_member)
  on public.profiles to authenticated;

grant update (display_name, avatar_url, preferences, onboarding_step, costco_member)
  on public.profiles to authenticated;
