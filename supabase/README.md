# supabase

The database, auth configuration, Edge Functions, and database tests. SQL migrations here are the source of truth for the schema; `packages/db` holds the generated types.

```
supabase/
├── config.toml        Local stack and auth settings (providers, redirect URLs, templates)
├── migrations/        Numbered SQL, applied in order
├── functions/         Edge Functions (Deno): health, export-data, more in later workstreams
├── templates/         Auth email templates (magic link)
├── seed/              Local and CI seed data
└── tests/             pgTAP tests, run by `supabase test db`
```

## Migration convention

WS01 creates the identity tables only (`households`, `household_members`, `household_invites`, `profiles`, `audit_events`) and sets the pattern for the rest: every later workstream adds its own numbered migration, made with `pnpm supabase migration new <name>`, for the tables it owns, in the order listed in `docs/02-data-model.md` §Migration ownership. A migration alters another workstream's table only where `docs/02-data-model.md` §Migration ownership lists that change (for example WS06's columns on `profiles`, or WS07's foreign key on `households.default_connection_id`); anything else is a contract change request, and the orchestrator applies it on `main`. Merged migrations are append-only, so fix forward with a new file. Name enums `<table>_<column>`, attach `public.set_updated_at()` to any table with an `updated_at` column, and keep tables and functions in `public`. A migration that creates another schema must add it to `supabase db lint --schema` in `.github/workflows/ci.yml`.

## RLS conventions

Row Level Security is how households stay apart (risk R9), so the rules are strict and every one is tested.

1. Enable RLS in the same migration that creates the table. Supabase grants every API role all privileges on new tables, so `revoke all ... from anon, authenticated` first, then `grant` only what a client may do. `anon` gets nothing on household data. Where only some columns are client-editable, grant UPDATE by column: on `households` that is `name` and `zip`. A migration that adds a column to such a table grants UPDATE on it explicitly, and only if clients should edit it.
2. A household-scoped table has a `household_id` column and policies `to authenticated`:

   ```sql
   alter table public.<table> enable row level security;
   create policy "<table>: members read" on public.<table>
     for select to authenticated
     using (household_id in (select public.current_household_ids()));
   -- insert: with check (...same...); update: using + with check; delete: using
   ```

3. Owner-only actions use `public.owned_household_ids()`. Do not subquery `household_members` inside a policy: the helpers are security definer so they bypass RLS on `household_members` and cannot recurse.
4. Writes a client must not do directly (joining a household, writing audit rows) go through a `security definer` function with `set search_path = ''`, fully qualified names, and an `auth.uid()` check. Revoke execute from `public` and `anon`, grant it to `authenticated`.
5. Never trust an id from the client for who is acting. Derive the user from `auth.uid()`.
6. Each new table gets assertions in `supabase/tests/NNN_rls_<area>.sql`: a member of household A reads zero rows of household B and cannot insert, update, or delete across households.

Helpers from WS01: `current_household_ids()`, `owned_household_ids()`, `is_household_peer(text)`, `set_updated_at()`.

## What the identity migrations provide

| Object | Who may call it | Notes |
|---|---|---|
| `create_household(name)` | signed in | Inserts the household and the caller as `owner` in one transaction. Returns the id |
| `create_invite(household_id)` | owner | Returns a 64 character hex token, valid 7 days, single use |
| `redeem_invite(token)` | signed in | Adds the caller as `member`, sets `used_at` and `used_by`, returns the household id. A caller who is already a member gets the id back and the invite stays valid. An invite whose creator is no longer an owner of the household, or whose creator's account is gone, is void (`invite_not_found`) |
| `leave_household(household_id)` | member | Deletes the caller's unused invites. The last owner leaving hands ownership to the longest-standing member. If nobody is left, the household is soft-deleted. Concurrent leaves of one household are serialized on its row |
| `list_household_members(household_id)` | member | Roster with display names and avatar paths. `profiles` is private to each user, so housemates see names only here |

Errors are plain codes in the message (SQLSTATE `P0001`): `not_authenticated`, `invalid_name`, `not_owner`, `not_a_member`, `invite_not_found`, `invite_used`, `invite_expired`. `@mp/db` maps them to `IdentityError`.

Clients cannot insert `households`, `household_members`, or `household_invites` rows and cannot write `audit_events`. An owner can update only `households.name` and `households.zip`. Membership changes write `member_added`, `member_removed`, and `owner_transferred` audit events from triggers and the functions above.

## Storage

`avatars` is a private bucket (2 MiB, JPEG, PNG, or WebP). A user may write, replace, and delete only objects named `<user_id>/<file>`. A user reads their own avatars and those of people who share a household with them. The app turns paths into signed URLs.

## Auth

The app signs in with Apple, Google, or an email magic link, using the PKCE flow. The hosted project is configured in the dashboard; `config.toml` configures the local stack (CI) and lists the development redirect URLs.

**Redirect URLs** (Authentication -> URL Configuration). The development list is `additional_redirect_urls` in `config.toml`: the Expo web server on localhost, `mealplanner://**`, and `exp://**` for Expo Go. The production project lists only the deployed web origin (`https://<web-origin>/callback`) and `mealplanner://callback`. Do not leave `exp://**` or localhost wildcards on it: a wildcard on a development origin lets anyone who controls that origin receive sign-in codes. There is no staging project in v1 and the dev machine develops against the hosted one, so add the development URLs only while testing sign-in there and remove them before real households use it. Set the Site URL to the Expo web server in development and to the deployed web origin in production.

**Email magic link.** On by default. Paste `templates/magic_link.html` into Authentication -> Emails -> Magic Link on the hosted project. The email carries a link and a 6 digit code. Local emails appear in the Inbucket/Mailpit page that `supabase status` prints (port 54324).

**Apple.** Needs an Apple Developer account.
1. Create an App ID with the Sign in with Apple capability for the bundle id in `apps/mobile/app.json` (`com.miguelsolorio.mealplanner` today; change it before registering if the final name differs).
2. For web and Android, create a Services ID and set its return URL to `https://<project-ref>.supabase.co/auth/v1/callback`.
3. In Authentication -> Providers -> Apple, set Client IDs to the bundle id and the Services ID, comma separated, and paste the secret key JWT generated from your Apple private key. Apple secrets expire after 6 months.

Native iOS passes Apple's identity token and a hashed nonce straight to `signInWithIdToken`. Web and Android use the OAuth redirect.

**Google.** Create a Web application OAuth client in Google Cloud Console, add `https://<project-ref>.supabase.co/auth/v1/callback` as an authorized redirect URI, and enter the client id and secret under Authentication -> Providers -> Google. The native app uses the same browser flow, so no native Google SDK is needed.

`config.toml` ships both providers with `enabled = false`: the CLI refuses to start when an enabled provider has an empty client id or secret, and no credentials belong in the repo. To run them on a stack you control, export the `SUPABASE_AUTH_EXTERNAL_*` variables named in `.env.example` and set `enabled = true`.

## Edge Functions

- `health` (WS00): liveness and version.
- `export-data` (WS01): returns a JSON export of the caller's profile, memberships, households, rosters, invites (owners only), and audit events. It queries as the caller, so RLS decides what is included. Later workstreams add to the `SECTIONS` list in `functions/export-data/handler.ts`; they do not replace the function.

## Testing

`supabase test db` runs `tests/*.sql` with pgTAP against the local stack. The development Mac has no container runtime, so CI runs it (`.github/workflows/ci.yml`, job `supabase`). See `tests/README.md` for the impersonation pattern.

Deploy to the hosted project with `pnpm supabase db push` and `pnpm supabase functions deploy <name> --use-api` once `SUPABASE_ACCESS_TOKEN` is set. Human checkpoint 2 approves the identity migrations before they reach the hosted project.
