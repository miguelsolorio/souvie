# run-approve

The household's approval of a proposed shopping cart (WS09). It applies the person's review, checks the approved cart against the budget cap, remembers the products they confirmed, and opens the push phase for the shopper worker.

## Request

```http
POST /functions/v1/run-approve
Authorization: Bearer <the signed-in member's access token>

{ "runId": "<uuid>", "decisions": [
  { "runItemId": "<uuid>", "action": "swap", "alternativeIndex": 0 },
  { "runItemId": "<uuid>", "action": "quantity", "quantity": 1 },
  { "runItemId": "<uuid>", "action": "remove" }
] }
```

`action` is `keep`, `swap` (one of the line's own alternatives, by index 0 to 2), `remove`, or `quantity` (1 to 24). A line with no decision is accepted as proposed. At most 200 decisions.

## Responses

| Status | Body |
|---|---|
| 200 | `{ ok: true, runId, status: "running", subtotalUsd, itemCount }` |
| 400 | `invalid_request` (the body), `invalid_decision` (an index or quantity the line does not allow) |
| 401 | `unauthorized` |
| 403 | `not_a_member`: the run is another household's, or does not exist. The same answer for both |
| 409 | `not_reviewable` (the run is not at needs_review), `over_budget` (the approved subtotal is over `budget_cap_usd`), `empty_cart` (nothing left to add) |

Every error body is `{ ok: false, error, message }` with a message for the person.

## What it reads and writes

1. `auth.getUser` on the bearer token.
2. The run's household, joined to `household_members` for the caller, before anything else is read.
3. One transaction under `set local role service_role` (no DDL): the run (`for update`, must be `needs_review`), its `shopping_run_items`, the review applied with `@mp/agent`'s `applyReview` (`packages/agent/src/review.ts`, the code the replay tests run), the items updated, `product_matches` upserted for every line going to the cart (`chosen_by = 'user'` for a swap, `'agent'` for a line kept as proposed; ids, name and size only, never a price), the run moved to `running` with `approved_at`, `approved_by` and the approved `subtotal_usd`, and `shopping_run_dispatch(run_id)` to queue the push phase. A refusal writes nothing.

The function connects with `SUPABASE_DB_URL` as the database owner; `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are for `auth.getUser`. All three are set by Supabase for every function. `verify_jwt` stays on (`supabase/config.toml`).

## Tests

`handler.test.ts` runs the handler against the real migrations on PGlite (`testing/db.ts`, with Vault, pgmq and pg_cron stubs): another household's run answers 403 and leaves every row unchanged, an approval moves the run and dispatches it, the budget cap and bad decisions write nothing. `pgtap.test.ts` runs `supabase/tests/ws09_runs_rls.sql` through the pgTAP shim; CI runs it with the real pgTAP.
