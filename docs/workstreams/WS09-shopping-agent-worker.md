# WS09: Shopping agent + worker + review UI

**Wave:** 5 · **Suggested model:** Opus · **Branch:** `ws/09-shopping-agent-worker`

## Goal
When this is done, a household can press "Shop this list" (or a scheduled job can do it for them) and a Claude-driven agent turns the aggregated grocery list into concrete retailer line items, proposes a cart with alternatives, pauses for a 30-second phone review, pushes the approved items into the Kroger cart, and notifies the user that the cart is ready to pay. The agent runs in a long-lived Node worker fed by a Postgres queue, writes every step to a transcript, enforces budget and allergen policies in code rather than prompts, and never invents a product identifier. This is the moment the product delivers on "the agent shops for you" within what retailer APIs allow today.

## Depends on
- WS05 (Grocery list): `grocery_lists`, `grocery_list_items` with aggregated quantities and `excluded_reason`.
- WS07 (Retailer framework + Kroger): `RetailerAdapter`, `MockRetailer`, `KrogerAdapter`, `retailer_connections`, `product_matches`, `retailer_quota_usage`, typed errors.
- WS08 (Instacart adapter) should be merged so the agent can route hand-off stores, but the agent must work with Kroger and Mock alone if WS08 slips. Guard on `isAdapterAvailable('instacart')`.
- WS00 (scaffold) reserves the `services/shopper-worker` path, the `WORKER_DATABASE_URL` variable, and CI wiring for services. This WS creates the worker itself.

## Read first
1. `docs/03-ai-design.md` §4.1 (model tiers and SDK usage), §4.7 (line-item conversion and scoring), §4.8 (shopping agent, tools, policies, order of operations), §4.10 (eval harness).
2. `docs/04-integrations.md` §5.1 (contract) and §5.5 (Tier 3 modes; you build the hooks, WS10 builds the adapters).
3. `docs/02-data-model.md` Retail section: `shopping_runs`, `shopping_run_items`, `scheduled_runs` (read only here), `ai_runs`.
4. `docs/05-security-privacy.md` spending controls and audit paragraphs.
5. `docs/06-risks.md` rows R1, R3, R4, R10, R13, R15, R19, R21.
6. `packages/retailers/src/types.ts` (WS07) and `packages/retailers/src/mock/` fixtures.

## In scope
- `packages/agent`: host-agnostic TypeScript (no Node-only imports such as `fs`, `child_process`, `playwright`) so the same loop can later run inside the app's WebView host for Tier 3 Mode A. Contains the run state machine, policies, tool definitions, the planner that builds the proposed cart, the Anthropic tool-runner loop, transcript writer, and the deterministic allergen check.
- `services/shopper-worker`: Node 22 service that consumes the `shopping_run` queue from Supabase Queues (pgmq), loads the run, resolves the adapter and connection, executes `packages/agent`, writes progress rows, and exits cleanly on SIGTERM. Dockerfile and `fly.toml` plus a `railway.json` alternative.
- Queue plumbing: `supabase/migrations/<timestamp>_ws09_runs.sql` creates `shopping_runs`, `shopping_run_items`, the pgmq queue `shopping_run`, a `enqueue_shopping_run(list_id, connection_id, trigger, policy)` SQL function, and RLS.
- Line-item scoring per `docs/03-ai-design.md` §4.7: pinned `product_matches` > household past picks > unit-price fit > profile brand/size preferences > stock. Implemented as a pure function with tests. The model chooses among candidate indices; code resolves indices to `Product` references.
- Tools exposed to the model: `find_store`, `search_products`, `get_product`, `add_to_cart`, `set_quantity`, `remove_from_cart`, `view_cart`, `get_slots`, `request_review`, `select_slot`, `checkout`, `finish`. Each tool checks `capabilities` first and returns a structured "not supported, use handoff" result when the adapter cannot do it. `checkout` is enabled only for adapters whose `capabilities.checkout === 'browser'` and only after the review gate passed.
- Policies in code: `budget_cap` (subtotal ceiling), `per_item_ceiling`, `substitution: none | same_brand | any`, `allergen_block_list` from `profiles.preferences.allergies` of every household member, `auto_checkout` (default false; only meaningful for Tier 3 connections), `max_tool_calls`, `max_wall_clock_seconds`.
- Run state machine: `queued → running → needs_review → cart_ready → checking_out → checked_out`, with `failed` and `cancelled` reachable from any active state. Transitions are validated in code and written with timestamps.
- Order of operations for write-only carts: the agent builds the full proposed cart from searches with no cart writes, the run moves to `needs_review`, the user approves or edits, then the run pushes adds. Each `shopping_run_items` row records the exact `quantityDelta` sent and the result before the next call, so a retry resumes from the ledger. Corrections send negative deltas. For adapters with `cartRead === 'api'`, diff against `getCart()` instead.
- Review UI in `apps/mobile/features/shopping/`: run list, run detail with live progress (Supabase Realtime on `shopping_runs`), proposed cart grouped by section with chosen product, price, and up to three alternatives, swap/remove/quantity controls, "Approve and fill cart" button, "Open store to pay" deep link, transcript viewer, and cancel.
- Expo Push: "Cart ready at QFC Duvall, $142.17. Review and pay." on `cart_ready`; "3 items need your call" on `needs_review`. (WS11 adds scheduling and the other notification types; this WS adds the two run events and the push token table if WS01 did not.)
- Replay tests: recorded runs against `MockRetailer` in `packages/agent/evals/runs/*.json`, replayed with a mocked model that returns the recorded tool choices, asserting final ledger and state.
- `ai_runs` logging for every model call, with `kind = 'agent.plan' | 'agent.step'`.

### Tool table

| Tool | Requires capability | Side effect | Allowed in states |
|---|---|---|---|
| `find_store` | `search` any | none | running |
| `search_products` | `search = api \| browser` | catalog read, quota counted | running |
| `get_product` | `search = api \| browser` | catalog read | running |
| `choose_product` | none (internal) | writes proposed `shopping_run_items` row, no cart write | running |
| `request_review` | none | transitions to `needs_review`, sends push | running |
| `add_to_cart` | `cartAdd = api \| browser` | ledger write then retailer write | running (push phase only, after approval) |
| `set_quantity` | `cartAdd` | ledger write then signed delta | running (push phase) |
| `remove_from_cart` | `cartRead = api \| browser` or negative delta via `cartAdd` | ledger write then retailer write | running (push phase) |
| `view_cart` | `cartRead = api \| browser` | read | running, cart_ready |
| `get_slots` | `slots = browser` | read | cart_ready |
| `select_slot` | `slots = browser` | retailer write | cart_ready |
| `checkout` | `checkout = browser` and review approved | retailer write, `checking_out` | cart_ready |
| `finish` | none | transitions to `cart_ready` or `checked_out` | running, checking_out |

For `cartAdd = handoff` (Instacart) the push phase calls the adapter once to obtain the URL and finishes with `cart_ready`; no item-level tools run.

### Run lifecycle walkthrough

1. `enqueue_shopping_run` inserts `shopping_runs (status = queued)` and sends a pgmq message `{ run_id }`.
2. Worker claims the message with a visibility timeout of 15 minutes, sets `running`, starts the heartbeat.
3. Planner loads list items (minus `excluded_reason`), pinned `product_matches`, allergies for every member, and the policy.
4. For pinned items: one `getProducts` batch per 50 to refresh price and stock. For unpinned items: one `search_products` each, up to 25 candidates.
5. The model receives each item with numbered candidates and calls `choose_product` with an index, or marks the item `unmatched` with a reason.
6. Code applies policies and the allergen check, computes subtotal, writes proposed `shopping_run_items`, snapshots the proposed cart into `cart_snapshot`, and calls `request_review`.
7. User reviews in the app, edits, approves through `run-approve`. The run returns to `running` in the push phase.
8. For each approved item, the ledger row gets `delta_sent`; then `add_to_cart` is called; then `delta_result` is written. A crash resumes from the first row without `delta_result`.
9. `finish` moves to `cart_ready`, sends the push, and schedules the alternatives nulling job.
10. Tier 1: the user taps "Open store to pay" and later confirms "I placed it" (writes `orders`). Tier 3 (WS10): `get_slots`, `select_slot`, `checkout` continue the run to `checked_out`.

## Out of scope
- Browser adapters, WebView bridge, session capture, consent copy (WS10). You ship the `checkout`, `get_slots`, `select_slot` tool plumbing and the capability checks; WS10 fills in the adapters.
- Cron scheduling, quiet hours, the remaining notification types, and `scheduled_runs` evaluation (WS11). You create the queue and the enqueue function WS11 will call.
- Order history views and spend charts (WS12). You write `orders` rows only on `checked_out` or on the user's manual "I placed it" confirmation.
- Changing the `RetailerAdapter` contract or table shapes beyond the migration listed here. File a contract change request instead.
- The in-app chat assistant surface. Build the tool layer so WS13 or a later WS can mount a chat on it, but do not build the chat UI.

## Deliverables
- `packages/agent/src/index.ts`, `state.ts` (state machine), `policies.ts`, `tools.ts` (tool schemas with `strict: true`), `planner.ts` (proposed cart builder and scorer), `loop.ts` (tool-runner loop), `transcript.ts`, `allergens.ts`, `ledger.ts`, `types.ts`.
- `packages/agent/src/*.test.ts` for state, policies, planner scoring, allergens, ledger, and loop (mocked model).
- `packages/agent/evals/runs/*.json` (≥5 recorded runs) and `packages/agent/evals/replay.test.ts`.
- `packages/llm/prompts/agent/system.v1.md`, `packages/llm/prompts/agent/review-summary.v1.md`.
- `services/shopper-worker/src/index.ts`, `queue.ts`, `runner.ts`, `heartbeat.ts`, `shutdown.ts`, `Dockerfile`, `fly.toml`, `railway.json`, `README.md`.
- `services/shopper-worker/src/*.test.ts` for queue claim/ack/dead-letter and heartbeat.
- `supabase/migrations/<timestamp>_ws09_runs.sql` and `supabase/tests/ws09_runs_rls.sql`.
- `supabase/functions/run-approve/index.ts`: user approval endpoint that validates membership, applies edits, and transitions `needs_review → running` for the push phase.
- `apps/mobile/features/shopping/RunList.tsx`, `RunDetail.tsx`, `ProposedCart.tsx`, `LineItemCard.tsx`, `TranscriptView.tsx`, `useShoppingRun.ts`, `useRunRealtime.ts`.
- `.env.example` additions: `WORKER_DATABASE_URL`, `WORKER_CONCURRENCY`, `WORKER_HEARTBEAT_SECONDS`.
- Docs update: `docs/03-ai-design.md` §4.8 gets the final tool table and state diagram as implemented.

## Interfaces
**Implements**
- Tables (shapes from `docs/02-data-model.md`): `shopping_runs (id, household_id, list_id, connection_id, trigger manual|scheduled, status, policy jsonb, cart_snapshot jsonb, subtotal, transcript jsonb, error, started_at, finished_at, heartbeat_at)`, `shopping_run_items (id, run_id, list_item_id, product_id, product_name, qty, unit_price, line_total, status matched|substituted|unmatched|removed, alternatives jsonb, user_decision, delta_sent, delta_result, sent_at)`.
- SQL function `enqueue_shopping_run(list_id uuid, connection_id uuid, trigger text, policy jsonb) returns uuid`.
- `RunPolicy` zod schema in `packages/core`: `{ budgetCapUsd: number | null; perItemCeilingUsd: number | null; substitution: 'none' | 'same_brand' | 'any'; autoCheckout: boolean; maxToolCalls: number; maxWallClockSeconds: number }` with defaults `{ budgetCapUsd: null, perItemCeilingUsd: null, substitution: 'same_brand', autoCheckout: false, maxToolCalls: 200, maxWallClockSeconds: 900 }`.
- Tool schemas (Anthropic tool definitions, `strict: true`). Example:
  ```ts
  { name: 'search_products', input_schema: { type: 'object', properties: { listItemId: { type: 'string' }, query: { type: 'string' }, limit: { type: 'integer', maximum: 25 } }, required: ['listItemId', 'query'], additionalProperties: false } }
  { name: 'choose_product', input_schema: { type: 'object', properties: { listItemId: { type: 'string' }, candidateIndex: { type: 'integer' }, quantity: { type: 'number' }, reason: { type: 'string' } }, required: ['listItemId', 'candidateIndex', 'quantity'], additionalProperties: false } }
  ```
  The model receives candidates as a numbered list and returns `candidateIndex`. Code maps the index to a `ProductRef { productId, upc }` from the search result. The model never writes a UPC.
- Realtime channel `shopping_runs:household_id=eq.<id>` for progress; the client subscribes with the anon key under RLS.
- Edge Function `POST /functions/v1/run-approve` body `{ runId, decisions: { runItemId, action: 'keep' | 'swap' | 'remove' | 'quantity', alternativeIndex?, quantity? }[] }`.
- Push payloads: `{ type: 'cart_ready', runId, storeName, subtotalUsd }`, `{ type: 'needs_review', runId, count }`.
- Exported for evals and WS15: `matchLineItems(items, adapter, store)` and `replayRun(fixture, adapter)` from `packages/agent`.
- `RunDetail` accepts an `actions` prop (React node) rendered below the cart summary, so WS12 can mount `ConfirmOrderSheet` without editing WS09 files.
- This WS does not create the `orders` table; WS12 owns it.

**Consumes**
- `RetailerAdapter` and `MockRetailer` (WS07), `InstacartAdapter` (WS08, optional).
- `packages/llm`: `createClient()`, tool-runner helper, `logAiRun()`. Model: `claude-sonnet-5-5` for the loop, `claude-haiku-5-5` for the review summary text.
- `grocery_list_items`, `ingredients`, `product_matches`, `retailer_connections`, `profiles.preferences.allergies`.
- Supabase Queues (`pgmq.send`, `pgmq.read`, `pgmq.archive`, `pgmq.delete`), Supabase Vault via WS07's token helpers.

**Hand-off adapters**
- When `capabilities.cartAdd === 'handoff'` (Instacart), the planner groups that store's items, calls `addToCart` once to obtain the hand-off URL, stores it in `cart_snapshot.handoffUrl`, and moves straight to `cart_ready` with a push that deep-links to the URL. No review of product choices is possible because Instacart does the matching.

## Acceptance criteria
1. `pnpm typecheck && pnpm lint` pass. `grep -rn "from 'fs'\|from 'node:\|playwright" packages/agent/src` returns nothing.
2. `state.test.ts`: every legal transition succeeds; `queued → cart_ready` throws; `checked_out → running` throws.
3. `policies.test.ts`: a proposed cart over `budgetCapUsd` moves the run to `needs_review` with a `budget` flag; an item over `perItemCeilingUsd` is flagged; `substitution: 'none'` rejects a candidate whose brand differs from the pinned match.
4. `allergens.test.ts`: a proposed product whose `allergens` include a household member's allergy is removed and flagged before review; the check runs even if the model marked it safe.
5. `planner.test.ts`: scoring order is pinned > past pick > unit-price fit > profile preference > stock, proven by fixtures where each factor alone decides the winner; the chosen product always comes from the candidate list (index resolution), never from model text.
6. `loop.test.ts` with a mocked model: a run against `MockRetailer` for a 12-item list produces 12 `shopping_run_items`, at least 10 `matched`, zero cart writes before `needs_review`, and a transcript with one entry per tool call.
7. `ledger.test.ts`: after a simulated crash between item 5 and 6 during the push phase, resuming sends deltas only for items 6 to 12; a user quantity change from 2 to 1 after push sends a delta of -1.
8. `replay.test.ts`: all recorded runs replay to their recorded final state and ledger.
9. `queue.test.ts`: two worker instances claiming the same message do not both process it; a message that fails three times lands in the dead-letter archive and the run is marked `failed` with `error`.
10. `heartbeat.ts` updates `shopping_runs.heartbeat_at` at least every `WORKER_HEARTBEAT_SECONDS`; a run with a stale heartbeat older than 3 intervals is marked `failed` by the worker's sweeper.
11. `supabase test db` passes `ws09_runs_rls.sql`: a member of household A cannot read household B's runs, items, or transcripts; the service role can.
12. End to end on the iOS Simulator with `MockRetailer` selected in dev settings: tap "Shop this list" → run appears with live progress → `needs_review` shows the proposed cart with alternatives → swap one item → approve → run reaches `cart_ready` → push notification received in the simulator → "Open store to pay" opens the mock checkout URL. Record a screen recording path in the report.
13. End to end with the real Kroger adapter and the developer's own Kroger account (`KROGER_LIVE_TEST=1`, local only): the approved cart appears in kroger.com/checkout with the correct quantities and `PICKUP` modality. Record the item count in the report.
14. Every model call in a run writes an `ai_runs` row; the sum of `cost_usd` for the 12-item mock run is under $0.25 with `claude-sonnet-5-5`.
15. `pnpm --filter shopper-worker dev` against local Supabase logs an idle poll within 5 seconds and exits within 10 seconds of SIGTERM with no in-flight run lost (the run returns to `queued`).

## Verification commands
```bash
pnpm typecheck && pnpm lint                               # expected: exit 0
pnpm test --filter agent --filter shopper-worker          # expected: state, policies, allergens, planner, loop, ledger, replay, queue tests green
supabase start && supabase db reset && supabase test db   # expected: ws09 migration applies, pgmq queue exists, RLS test passes
pnpm --filter shopper-worker dev &                        # expected: "idle: no messages" log within 5s
psql "$WORKER_DATABASE_URL" -c "select enqueue_shopping_run('<list>', '<mock-conn>', 'manual', '{}'::jsonb);"
psql "$WORKER_DATABASE_URL" -c "select status, subtotal from shopping_runs order by started_at desc limit 1;"   # expected: needs_review or cart_ready
pnpm eval agent                                           # expected: replay pass rate 100%, cost per mock run printed
pnpm --filter mobile start                                # manual: full review flow on iOS Simulator with MockRetailer
KROGER_LIVE_TEST=1 pnpm --filter shopper-worker dev       # manual, local only: real Kroger run, verify at kroger.com/checkout
```

## Risks and notes
- R13: the model never emits UPCs or product IDs; it picks indices. Enforce this in the tool schema (`candidateIndex` integer) and in code (reject indices out of range, retry once, then flag the item `unmatched`).
- R4: the allergen check is deterministic and runs on the proposed cart using `Product.allergens`. Where the catalog returns no allergen data, flag the item for review when the ingredient's ontology category is in a household allergen group.
- R21: Kroger forbids storing search-derived data. `shopping_run_items.alternatives` holds only `{ productId, upc, name, size, price }` for the life of the run and is nulled when the run reaches `checked_out`, `failed`, or `cancelled`, or 7 days after `cart_ready`. Prices in the ledger are what the user approved, kept as the household's own purchase record. The orchestrator is seeking Kroger's written view on this; keep the nulling behind a config so it can be tightened.
- R15: quota. Use `getProducts()` batch lookups for pinned items first; one `search_products` call per unpinned item; cap at `maxToolCalls`. On `RetailerQuotaError`, pause the run (`needs_review` with a `quota` flag) rather than fail.
- R10: stalled jobs. Heartbeat plus sweeper plus dead-letter; `shopping_runs.status` is always visible in the app.
- R19: today no API can pick a slot or pay. The `cart_ready` push and the "Open store to pay" deep link are the product's honest end of Tier 1. Make them excellent.
- Idempotency: never call `addToCart` without first writing the intended delta to the ledger. Never trust a transcript to recover; the ledger is the source of truth.
- Keep `packages/agent` free of Node-only dependencies so WS10's Mode A can host the same loop in the app with a WebView-backed adapter.
- Cost: `claude-sonnet-5-5` for the loop with prompt caching on the system prompt, policies, and preferences; `claude-haiku-5-5` for summaries. Log everything; the `ai_runs` sum is an acceptance criterion.

## Completion report
End with the report format from `docs/implementation-guide.md` §6.2 (Message templates) (Built, Files changed, Verification output, Deviations from brief, Contract change requests, Open issues, Follow-ups). Nothing else is read by the orchestrator.
