# supabase/tests

pgTAP tests for the database, run with `supabase test db` against the local stack. The extensions migration enables `pgtap`.

The main job of this folder is RLS. Every household-scoped table gets a test that a member of household A cannot select, insert, update, or delete any row of household B (`docs/02-data-model.md` §RLS pattern). The workstream that creates a table adds its test here in the same branch.

Conventions:

- One file per migration area, numbered: `001_rls_identity.sql` (WS01), `002_rls_recipes.sql` (WS02), and so on.
- Each file wraps its work in `begin; ... rollback;` and starts with `select plan(n);`.
- Impersonate users with `set local role authenticated;` and `set local request.jwt.claims = '{"sub": "<uuid>"}';`.
- Fixtures come from `supabase/seed/` or are created inside the test transaction.

WS01 ships `001_rls_identity.sql`, and the `supabase` job in `.github/workflows/ci.yml` runs `supabase test db` after `db reset`. The development Mac has no container runtime, so these tests run in CI only.

`004_rls_planning.sql` (WS04) also covers triggers and Realtime: the household, week and recipe checks on entries, the saved, cooked and skipped feedback written with an entry change, column-level grants, and the `supabase_realtime` publication with `replica identity full`. It simulates the service role with `set local request.jwt.claims = '{"role": "service_role"}'; set local role service_role;`. Claims set with `set local` outlive `reset role` for the rest of the transaction, so a step that must run with no signed-in user has to clear them this way, not just reset the role.

`001_rls_identity.sql` shows the pattern: fixtures inserted as `postgres` (which bypasses RLS), then `set local request.jwt.claims = '{"sub": "<uuid>", "role": "authenticated"}'; set local role authenticated;` to act as a user, `reset role;` to step back. Denied reads show up as empty results and denied updates and deletes as zero rows affected, so the file defines a small `public.__t_affected(sql)` helper inside its transaction to count them. A missing privilege or a failed `with check` raises `42501`, which `throws_ok` asserts.
