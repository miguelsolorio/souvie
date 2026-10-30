# supabase/tests

pgTAP tests for the database, run with `supabase test db` against the local stack. The extensions migration enables `pgtap`.

The main job of this folder is RLS. Every household-scoped table gets a test that a member of household A cannot select, insert, update, or delete any row of household B (`docs/02-data-model.md` §RLS pattern). The workstream that creates a table adds its test here in the same branch.

Conventions:

- One file per migration area, numbered: `001_rls_identity.sql` (WS01), `002_rls_recipes.sql` (WS02), and so on.
- Each file wraps its work in `begin; ... rollback;` and starts with `select plan(n);`.
- Impersonate users with `set local role authenticated;` and `set local request.jwt.claims = '{"sub": "<uuid>"}';`.
- Fixtures come from `supabase/seed/` or are created inside the test transaction.

WS00 ships no tests. CI runs `supabase db lint` today. WS01 adds `supabase test db` to `.github/workflows/ci.yml` with the first policies.
