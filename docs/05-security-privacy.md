# 05 · Security and privacy

The app holds retailer credentials by proxy, moves money by handing off to retailers, and knows what a household eats and buys. These controls are not optional polish; several are preconditions for the retailer terms in `04-integrations.md`.

## Access control

- Row Level Security on every household-scoped table using `current_household_ids()` (see `02-data-model.md`). Owner-only actions check `role = 'owner'`.
- The anon key is the only key in the app bundle. The service-role key exists only in the worker and Edge Functions and is never logged.
- Service-role code filters by `household_id` explicitly on every query. A helper in `packages/db` refuses to run a household-scoped query without one.
- pgTAP tests in `supabase/tests/` assert, for every household-scoped table, that a member of household A reads zero rows of household B and cannot insert into B. CI runs them from WS01 onward.
- Invite links expire in 7 days and are single-use.

## Retailer credentials and sessions

- Kroger OAuth refresh tokens live in Supabase Vault; `retailer_connections.vault_secret_id` points at them. Tokens are rotated on every refresh (Kroger reissues refresh tokens) and the old secret version is deleted.
- Tier 3 browser sessions store cookies and local storage state only, encrypted on the device (`expo-secure-store`) with a per-connection key held in Vault, scoped to one connection. The encrypted blob never leaves the device. Retailer passwords are never stored, logged, or transmitted to our servers. Sign-in happens in the retailer's own page inside the WebView.
- A "Disconnect" action revokes the Kroger token where the API allows, deletes the Vault secret, and sets `status = 'revoked'`. For browser sessions it deletes the Vault key, the secure-store entry, and clears the WebView cookie store.
- Browser-session keys, as built (WS08). `connect_browser_session(household_id, retailer)` runs after the person signs in on the retailer's own page in the WebView; it requires membership and the household's consent for that retailer at the current copy version, creates (or re-activates) the member's `browser_session` row, and creates its key in Vault: 32 random bytes, base64, one secret per connection, `vault_secret_id` pointing at it. `connection_session_key(connection_id)` returns the decrypted key only to the connection's own member while they belong to the household and the row is not revoked; another member of the same household, a member of another household, and a revoked row all get `not_allowed` or `connection_revoked`, and `authenticated` cannot read `vault.secrets` or `vault.decrypted_secrets` at all. The phone holds the key in memory for the run and drops it at the end of the run or in the background; it is never written to disk. The session is sealed with AES-256-GCM (12-byte nonce, the connection id as additional data) and stored as one `expo-secure-store` entry, `tier3.session.<connection_id>`, keychain class "when unlocked, this device only". It holds cookies for the retailer's own registered domains and that origin's storage only; entries named like a password are dropped. When the secure store is unavailable the app does not save at all and the person signs in each run. At the end of each run, and after sign-in, the plaintext copy is cleared from the WebView (the retailer's cookies and the page's storage) whether or not sealing worked, so at rest the session exists only as ciphertext. If the session cannot be sealed right after sign-in, the connection just created is revoked at once (its Vault key deleted), so no active connection is left without a sealed session behind it.
- Browser-session disconnect, in order (WS08, `wipeSession`): (1) the in-memory key is dropped; (2) the WebView cookie store is cleared; (3) the secure-store entry is deleted; (4) `revoke_browser_connection(connection_id)` deletes the Vault secret, sets `vault_secret_id = null` and `status = 'revoked'`, clears the household's default connection if it pointed here, and writes a `connection_revoked` audit event. Every step runs even when an earlier one fails, and the first error is shown afterwards; steps 1 to 3 happen on the phone first, so they complete offline, and the person retries step 4 if it failed. Only the connection's own member can disconnect it, because the session is on their phone. A later connect makes a new key, so an old blob can never be opened again.
- Connections flip to `needs_reauth` on a 401 and the app prompts the owning user; the agent never retries auth in a loop.
- Edge Functions that need SQL beyond PostgREST (`suggest` today, the WS09 worker next) connect with `SUPABASE_DB_URL` as the database owner, which bypasses Row Level Security, so every query in them scopes by household by hand and the reviewer reads each one. Before WS09 is dispatched the orchestrator decides whether those connections run under `set local role service_role` so they lose DDL and keep only table privileges. Recorded 2026-10-30 from the WS06 review.

## Money

- No card number, CVV, or bank detail ever touches our systems. Payment happens inside the retailer's app (Tier 1) or inside the retailer's own checkout page driven in the WebView (Tier 3).
- Spending controls enforced in code: `budget_cap_usd` per run, `item_ceiling_usd` per item, a daily maximum number of runs per household, and `auto_checkout` off by default. The agent cannot change policy; only a household owner can, in settings, and the change is logged.
- Tier 3 checkout requires an approved review or an owner-set `auto_checkout_cap_usd`. The confirmation page total is captured into `orders.total_usd` and shown in the run summary.

## Audit

- `shopping_runs.transcript` records every tool call with timestamp, tool, input, output summary, and screenshot path for browser steps. The review screen can show it. Screenshots are deleted after 30 days by a Storage lifecycle rule. Transcripts are retained 90 days, then summarized.
- `ai_runs` records every model call. A per-household daily cost cap is enforced in `packages/llm`.
- Policy changes, connection changes, and household membership changes write an `audit_events` row (WS01 adds the table; other WS write to it).

## Allergen safety

- Allergies are hard filters in SQL during suggestion and a deterministic check on the proposed cart using `Product.allergens` where present and Open Food Facts ingredient text for UPCs that lack it.
- A model output that includes an allergen is dropped and logged, never shown. The model never gets the last word.
- Where allergen data is missing for a product, the item is flagged `needs_review` with the reason "allergen data unavailable."

## Privacy

- Purchase and dietary history is sensitive. Household members see shared plans, lists, and orders. Personal preference details (`profiles.preferences`) are visible only to that user and to the suggestion function.
- Export-my-data (JSON of everything the user and their households own) and delete-my-account exist from v1. Cheap now, mandatory for any public launch and for Kroger's data-portability clause.
- Analytics (PostHog) receive event names and anonymous ids, never recipe titles, product names, or dollar amounts in v1.
- Push notifications contain the subtotal but no item names on the lock screen.
- No personal data in URL query strings. Deep links carry opaque ids.
- The device cache (TanStack Query persister) holds what the signed-in member can already read: the active household row, including its `zip` and `default_connection_id`, plus the plans and entries the planner opens offline. It never holds retailer tokens, catalog data or prices. Sign-out clears it. Added 2026-10-30 from the WS04 review. The grocery list's replay queue (check-offs, edits and added items not yet sent) is kept outside that cache and persists per user and household, so only that signed-in user replays it and another person who signs in on the same device leaves it parked until its owner signs in again (WS05, review fix).

## Recipe content

- Imported recipes are stored for the household's private use with `source_url` and attribution. Ingredient lists are facts; instruction prose and images are copyrightable. The shared `catalog` contains only our own or licensed recipes. Nothing scraped is republished publicly.
- Video import is caption-only and never downloads media (see `03-ai-design.md` §4).

## Retailer-terms controls that are also security controls

- No cached catalog data beyond cache headers; no stored search results. This limits what a breach could expose and keeps Kroger access alive.
- `cart_snapshot` cleared 24 hours after a run closes.
- Browser automation runs only after the household accepts consent copy approved by the human, shown once at connect per retailer. The flag `tier3_browser_checkout` is a per-retailer kill switch. It never runs from cloud IPs.

## Secrets handling in the repo

- `.env.example` lists every variable with a placeholder. `.env.local` is gitignored. CI uses GitHub Actions secrets.
- Builders and reviewers never paste secret values into completion reports, commits, or docs. A pre-commit check greps for common key patterns.

## Incident basics (v1 scale)

- Kill switches: PostHog flags `tier3_browser_checkout` and `shopping_agent_enabled`.
- A retailer lockout or terms complaint: disable the adapter via flag, notify the household, record in `docs/status.md` decisions log.
- A suspected token leak: rotate Vault secrets, force `needs_reauth` on all connections, rotate the service-role key.
