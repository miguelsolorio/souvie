-- WS14: waitlist for the marketing site (docs/02-data-model.md, migration order 15).
--
-- Public insert, no read. Anyone holding the anon key (it ships in the landing page) can add
-- an email. Nobody but the service role can read, change, or delete rows. The service role
-- bypasses RLS, so there is no policy for it.

create table public.waitlist (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  -- Optional. The form asks for it so we can tell people when their stores are live.
  zip text,
  -- Where the sign-up came from: 'landing' by default, or a short tag from ?ref=.
  source text not null default 'landing',
  created_at timestamptz not null default now(),

  -- The anon key is public, so the table defends itself. These checks stop junk and oversized
  -- values from a client that skips the form.
  constraint waitlist_email_format check (
    email = btrim(email)
    and length(email) between 3 and 254
    and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ),
  constraint waitlist_zip_format check (zip is null or zip ~ '^[0-9]{5}$'),
  constraint waitlist_source_format check (source ~ '^[a-z0-9._-]{1,64}$')
);

comment on table public.waitlist is
  'Marketing site sign-ups (WS14). Anon can insert and nothing else. Read through the service role only.';

-- One row per person, whatever the casing. A duplicate insert fails with SQLSTATE 23505, which
-- the form turns into "You're already on the list."
create unique index waitlist_email_lower_key on public.waitlist (lower(email));

alter table public.waitlist enable row level security;

-- Grants are explicit so the result does not depend on the project's default privileges for new
-- tables (config.toml: api.auto_expose_new_tables). Anon may insert three columns. id and
-- created_at always come from the defaults. There is no select, update, or delete grant.
revoke all on table public.waitlist from anon, authenticated;
grant insert (email, zip, source) on table public.waitlist to anon;

create policy waitlist_insert_anon on public.waitlist
  for insert to anon
  with check (true);
