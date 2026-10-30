-- WS14: waitlist is insert-only for anon (supabase/migrations/*_waitlist.sql).
-- Run with `supabase test db`. Everything happens inside a transaction that rolls back.
--
-- pgTAP records results in temp tables owned by the session user, so assertions must not run
-- while the role is switched to anon. The two helpers below switch to anon, run one statement,
-- and switch back, so the assertions around them stay as the session user.

begin;

select plan(19);

create function pg_temp.as_anon(statement text) returns void
language plpgsql as $$
begin
  set local role anon;
  execute statement;
  reset role;
end;
$$;

create function pg_temp.anon_row_count() returns bigint
language plpgsql as $$
declare
  n bigint;
begin
  set local role anon;
  select count(*) into n from public.waitlist;
  reset role;
  return n;
end;
$$;

-- Shape ---------------------------------------------------------------------------------

select has_table('public', 'waitlist', 'waitlist exists');

select columns_are(
  'public', 'waitlist',
  array['id', 'email', 'zip', 'source', 'created_at'],
  'waitlist has the documented columns'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.waitlist'::regclass),
  'row level security is enabled'
);

select has_index(
  'public', 'waitlist', 'waitlist_email_lower_key',
  'unique index on lower(email) exists'
);

select ok(
  (select indisunique from pg_index where indexrelid = 'public.waitlist_email_lower_key'::regclass),
  'the lower(email) index is unique'
);

-- Anon can insert ------------------------------------------------------------------------

select lives_ok(
  $$select pg_temp.as_anon($q$
    insert into public.waitlist (email, zip, source) values ('Ada@Example.com', '98019', 'test')
  $q$)$$,
  'anon can insert a sign-up'
);

select lives_ok(
  $$select pg_temp.as_anon($q$
    insert into public.waitlist (email) values ('grace@example.com')
  $q$)$$,
  'anon can insert with only an email, and zip and source take their defaults'
);

select is(
  (select source from public.waitlist where lower(email) = 'grace@example.com'),
  'landing',
  'source defaults to landing'
);

-- Duplicates -----------------------------------------------------------------------------

select throws_ok(
  $$select pg_temp.as_anon($q$
    insert into public.waitlist (email) values ('ada@example.com')
  $q$)$$,
  '23505',
  null,
  'a duplicate that differs only by case is rejected (unique violation)'
);

-- Anon cannot read, change, or delete ------------------------------------------------------

select throws_ok(
  $$select pg_temp.anon_row_count()$$,
  '42501',
  null,
  'anon cannot select (no select grant)'
);

select throws_ok(
  $$select pg_temp.as_anon($q$update public.waitlist set source = 'tampered'$q$)$$,
  '42501',
  null,
  'anon cannot update'
);

select throws_ok(
  $$select pg_temp.as_anon($q$delete from public.waitlist$q$)$$,
  '42501',
  null,
  'anon cannot delete'
);

select throws_ok(
  $$select pg_temp.as_anon($q$
    insert into public.waitlist (id, email) values (gen_random_uuid(), 'id@example.com')
  $q$)$$,
  '42501',
  null,
  'anon cannot choose id or created_at'
);

-- Defense in depth: if a select grant ever slipped in, RLS still returns zero rows. The grant
-- is rolled back with the transaction.
grant select on public.waitlist to anon;

select is(
  pg_temp.anon_row_count(),
  0::bigint,
  'anon select returns zero rows even with a select grant, because no select policy exists'
);

select is(
  (select count(*) from public.waitlist),
  2::bigint,
  'the two accepted sign-ups are stored (checked as the session user)'
);

-- Bad input -------------------------------------------------------------------------------

select throws_ok(
  $$select pg_temp.as_anon($q$insert into public.waitlist (email) values ('not-an-email')$q$)$$,
  '23514',
  null,
  'a malformed email is rejected'
);

select throws_ok(
  $$select pg_temp.as_anon($q$insert into public.waitlist (email, zip) values ('zip@example.com', '9801')$q$)$$,
  '23514',
  null,
  'a malformed zip is rejected'
);

select throws_ok(
  $$select pg_temp.as_anon($q$insert into public.waitlist (email, source) values ('src@example.com', 'Bad Source!')$q$)$$,
  '23514',
  null,
  'a malformed source is rejected'
);

select throws_ok(
  $$select pg_temp.as_anon($q$insert into public.waitlist (email) values (' padded@example.com')$q$)$$,
  '23514',
  null,
  'an email with leading whitespace is rejected'
);

select * from finish();

rollback;
