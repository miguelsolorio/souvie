# list-build

Turns a household's plan for a week into one grocery list. Scales every recipe line to the servings planned, adds up lines per ingredient, takes out what the pantry covers, rounds to amounts a person can buy, and orders the result by store section (`docs/03-ai-design.md` §6). Built in WS05.

Requires a signed-in user who belongs to the household: send the user's JWT as `Authorization: Bearer <jwt>` (`verify_jwt` stays on).

## Request

`POST /functions/v1/list-build`, JSON. The shape is `ListBuildRequest` in `@mp/core` (`packages/core/src/list/types.ts`).

| Field | Meaning |
|---|---|
| `weekStart` | A Monday, `YYYY-MM-DD`. Any other day is `invalid_request` |
| `householdId` | Optional. The household to act in; the caller must be a member. Defaults to the household the caller joined most recently |

```bash
curl -s -X POST "$SUPABASE_URL/functions/v1/list-build" \
  -H "Authorization: Bearer $USER_JWT" -H "Content-Type: application/json" \
  -d '{"weekStart":"2026-11-02"}'
```

## Response

```json
{ "ok": true, "listId": "…", "itemCount": 24, "needsAttentionCount": 2, "alreadyHaveCount": 6,
  "planVersion": 1, "skippedEntryCount": 0, "rebuilt": false }
```

| Field | Meaning |
|---|---|
| `itemCount` | Items to buy: everything the pantry does not cover, and nothing a person took off the list |
| `needsAttentionCount` | Items to buy with the needs-attention flag: lines the parser could not place, and amounts that could not be added up |
| `alreadyHaveCount` | Items the pantry covers; the app shows them under "Already have" |
| `planVersion` | The build counter: 1 for the first build, +1 on every rebuild |
| `skippedEntryCount` | Planned dinners whose recipe is gone, which added nothing |
| `rebuilt` | True when the plan already had a list and this build refreshed it |

Failed: `{ "ok": false, "error": "…", "message": "…" }`.

| `error` | HTTP | Meaning |
|---|---|---|
| `unauthorized` | 401 | Missing or invalid token |
| `invalid_request` | 400 (413 if the body is over 2 KB) | Bad JSON, no `weekStart`, or a date that is not a Monday |
| `not_a_member` | 403 | `householdId` is not one of the caller's |
| `no_household` | 403 | The caller belongs to no household |
| `no_plan` | 200 | Nothing is planned for that week. The app opens the planner |
| `internal_error` | 500 | Anything else. The body carries no internal detail |

## What a build does

All in one transaction (`store.ts`), after an advisory lock on the household and week that is meant to make two phones tapping "Generate list" build one list, one after the other. A device never sees the list half replaced. The lock has not been tested under real concurrency: PGlite is one connection, so the tests check only where it sits (the first statement after the role switch, before any plan is read) and that two builds in a row make one list. Two builds racing on separate connections have not been run:

1. Load the plan, its entries, the entries' recipes (the household's own and the starter catalog's), their ingredient lines, the ontology rows those lines name, and the household's pantry.
2. `buildList` (`packages/core/src/list/aggregate.ts`) computes the draft. It is pure and fixture-tested.
3. Create the plan's `grocery_lists` row, or update it: `plan_version` +1, `built_at`, and `plan_fingerprint`, the SHA-256 of the plan's entries as sorted `(id, recipe_id, servings, status)` tuples. The app computes the same hash from the entries it holds and shows "List is out of date" when they differ.
4. Fold the draft into the rows already on the list (`reconcileItems`, same folder). A row for an ingredient that is still planned is updated in place, so its `id`, `checked`, `checked_by` and `checked_at` survive. Manual items (`is_manual`) are never touched. A row a person edited keeps its quantity, unit and section; a row a person took off the list (`excluded_reason = 'manual'`) stays off. Rows for ingredients that left the plan are deleted. New ingredients are inserted unchecked. Updates write only rows that changed.

A new list starts with the aisle order (`section_order`) of the household's latest list.

## What it reads and writes

The function connects to Postgres as the database owner (`SUPABASE_DB_URL`) and starts every transaction with `set local role service_role`. That keeps the table privileges below and bypasses Row Level Security like the service role does, and it drops the owner's ability to create, alter or drop tables. Because RLS is bypassed, every statement names the household explicitly, and the household id comes from the membership check made first.

| Table | Access | Columns used |
|---|---|---|
| `household_members`, `households` | read | membership, `deleted_at` |
| `meal_plans`, `meal_plan_entries` (WS04) | read | plan by `(household_id, week_start)`; entries `(id, recipe_id, date, slot, servings, status, position)` |
| `recipes`, `recipe_ingredients` (WS02) | read | `recipes(id, title, servings, deleted_at)` for the household's own and `visibility = 'catalog'`; lines `(id, recipe_id, position, raw_text, qty, qty_max, unit, ingredient_id, prep_note, optional, container_count, container)` |
| `ingredients` (WS03) | read | the whole row for the ids the lines name |
| `pantry_items` | read | `(ingredient_id, status)` |
| `grocery_lists` | read, insert, update | everything |
| `grocery_list_items` | read, insert, update, delete (automatic rows only) | everything except the check columns, which it never writes |

## Configuration

Supabase provides `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_DB_URL` to every Edge Function. There is nothing to set.

## Tests

`pnpm test` runs `handler.test.ts` (request handling against a fake store), `handler.store.test.ts` (the handler on the real store: a caller who names a household they are not in, or one they left or that was deleted, gets 403 and changes no row; where the lock sits), `pantry.test.ts` (the client's pantry write turned into the SQL PostgREST generates and run as `authenticated`), `store.test.ts` (the SQL on PGlite with the repo's migrations: the week of five dinners, rebuilds, the pantry, the role), and `pgtap.test.ts` (the pgTAP files `004_rls_planning.sql` and `006_rls_lists.sql` through a small shim, `testing/pgtap-shim.sql`, because the development Mac has no container runtime; CI runs them with real pgTAP). PGlite is Postgres 18 and the hosted project runs 17; the SQL used is plain.

JSON parameters need care. postgres.js runs every value bound to a `json` or `jsonb` parameter through `JSON.stringify`, strings included. A string that is already JSON, bound under `$1::jsonb`, reaches Postgres as a JSON string scalar, and `jsonb_to_recordset` answers `22023 cannot call jsonb_to_recordset on a non-array`. That broke "Build grocery list" on the hosted project (2026-10-31) while every PGlite test passed, because PGlite hands a string through untouched. The store now binds its rows as text and casts in SQL (`$1::text::jsonb`), which every driver sends as given. Two checks keep it that way:

- `testing/db.ts` binds JSON the way postgres.js does, and `json-params.test.ts` pins that. It also fails on a bare `$n::json` or `$n::jsonb` in any function source.
- `store.postgres.test.ts` runs the five-dinner build and a rebuild through the real driver on a real Postgres. It runs only when `LIST_BUILD_TEST_DATABASE_URL` is set, so `pnpm test` stays container-free. CI's `supabase` job sets it to the stack's database after `db reset`.
