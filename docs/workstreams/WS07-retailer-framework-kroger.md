# WS07: Retailer framework + Kroger adapter

**Wave:** 2 · **Suggested model:** Opus · **Branch:** `ws/07-retailer-framework-kroger`

## Goal
When this is done, the repo has one contract every store integration implements, the `RetailerAdapter` interface in `packages/retailers`, plus two implementations: a `MockRetailer` with fixtures for tests, and a production `KrogerAdapter` covering QFC and Fred Meyer. A household member can connect their Kroger account with OAuth from inside the app, pick a store, search products with live store prices, and push items into their own Kroger cart with a chosen fulfillment modality. The shopping agent (WS09), the assisted-checkout host (WS08), and the browser adapters (WS10) all build on this contract, so getting it right here keeps every later workstream from touching shared code.

## Depends on
- WS00 (scaffold): monorepo, `packages/core`, `packages/db` generated types, `.env.example`, CI, Supabase Vault enabled in the local stack.
- WS01 (auth & households): `households`, `household_members`, `profiles`, signed-in user context in `apps/mobile`, RLS pattern.
- Human checkpoint 3: the Kroger developer app is registered at developer.kroger.com and `KROGER_CLIENT_ID`, `KROGER_CLIENT_SECRET`, `KROGER_REDIRECT_URI` are in `.env.local`. Do not start without them. Credentials never enter the repo.

## Read first
1. `docs/04-integrations.md` §5.1 (adapter contract), §5.2 Kroger block (every endpoint, scope, quota, and terms constraint), §5.3 and §5.4 (feasibility and adapter plan).
2. `docs/02-data-model.md` Retail section: `retailer_connections`, `product_matches`, and the paragraph on what may not be stored.
3. `docs/05-security-privacy.md` on Vault, token rotation, and revocation.
4. `docs/06-risks.md` rows R13, R15, R21, R22.
5. `docs/03-ai-design.md` §4.7 (line-item scoring) so `Product` carries the fields the scorer needs.

## In scope
- `packages/retailers` with the `RetailerAdapter` interface, shared types (`Store`, `Product`, `Cart`, `CartItem`, `CartResult`, `Slot`, `Order`, `ConnectionHandle`), a registry (`getAdapter(id)`, `isAdapterAvailable(id)`, `listAdapters()`), and typed errors (`RetailerAuthError`, `RetailerQuotaError`, `RetailerNotSupportedError`).
- `packages/retailers/src/mock/` MockRetailer: deterministic fixtures (≥200 products across produce, dairy, meat, pantry, frozen), a fake cart with read support, configurable failures and latency, used by WS09 replay tests.
- `packages/retailers/src/kroger/`: OAuth client (client credentials for catalog, authorization code with PKCE for cart), token storage via Supabase Vault, Locations, Products, Cart add, quota accounting, cache-header honoring, and a strict terms guard that strips nothing and reformats nothing in product display fields.
- `supabase/functions/retailer-oauth/`: the OAuth redirect handler that exchanges the code, writes the refresh token into Vault, and creates or updates `retailer_connections`.
- `supabase/migrations/<timestamp>_ws07_retail.sql`: `retailer_connections`, `product_matches`, `retailer_quota_usage`, RLS, and Vault secret references.
- UI in `apps/mobile/features/retailers/`: Connect Kroger button (opens the system browser with `banner=qfc|fredmeyer` based on primary store chain), store picker fed by Locations, connection status card, disconnect (revokes and deletes the Vault secret).
- A tiny dev-only "catalog explorer" screen under `apps/mobile/app/(dev)/catalog.tsx` for manual verification of search and add-to-cart, gated by `__DEV__`.
- Unit tests with recorded HTTP fixtures (no live calls in CI). One opt-in live smoke test behind `KROGER_LIVE_TEST=1`.

## Out of scope
- The WebView host, bridge, and session capture for browser adapters (WS08).
- Browser-driven adapters and the assisted run screen (WS10).
- The agent loop, line-item scoring implementation, review UI, run state machine (WS09). You only ship `Product` fields the scorer needs.
- Scheduled runs and push notifications (WS11).
- Order history (WS12); Kroger's public tier has no orders endpoint anyway.
- Any UI that compares prices across retailers. Kroger's terms forbid it. Do not build it "for later."
- Editing `packages/core` zod schemas beyond adding the retailer enums listed under Interfaces. Anything more is a contract change request.

## Deliverables
- `packages/retailers/src/index.ts`, `types.ts`, `registry.ts`, `errors.ts`, `capabilities.ts`.
- `packages/retailers/src/mock/MockRetailer.ts`, `fixtures/products.json`, `fixtures/stores.json`.
- `packages/retailers/src/kroger/KrogerAdapter.ts`, `auth.ts`, `locations.ts`, `products.ts`, `cart.ts`, `quota.ts`, `cache.ts`, `mappers.ts`, `terms.ts`.
- `packages/retailers/src/kroger/__fixtures__/*.json` (recorded responses for products, locations, token).
- `packages/retailers/src/kroger/*.test.ts` and `packages/retailers/src/mock/MockRetailer.test.ts`.
- `supabase/functions/retailer-oauth/index.ts`.
- `supabase/migrations/<timestamp>_ws07_retail.sql`.
- `supabase/tests/ws07_retail_rls.sql`.
- `apps/mobile/features/retailers/ConnectKroger.tsx`, `StorePicker.tsx`, `ConnectionCard.tsx`, `useRetailerConnection.ts`.
- `apps/mobile/app/(dev)/catalog.tsx`.
- `.env.example` additions: `KROGER_CLIENT_ID`, `KROGER_CLIENT_SECRET`, `KROGER_REDIRECT_URI`.
- Docs update: fill the "Implemented" column for Kroger in `docs/04-integrations.md` §5.4 and record the real quota numbers you observed in headers, if any, in `docs/09-open-questions.md`.

## Interfaces
**Implements (the shared contract; after this WS merges only the orchestrator edits it)**

```ts
export type Capability = 'api' | 'browser' | 'handoff' | 'none';
export type RetailerId = 'kroger' | 'safeway' | 'costco';
export type Modality = 'PICKUP' | 'DELIVERY';

export interface Capabilities {
  search: Capability; cartAdd: Capability; cartRead: Capability;
  slots: Capability; checkout: Capability; orders: Capability;
}

export interface Store { id: string; retailer: RetailerId; chain: string; name: string; address: string; zip: string; lat: number; lng: number; }
export interface Product {
  id: string; upc: string | null; name: string; brand: string | null; size: string | null;
  price: number | null; promoPrice: number | null;
  stockLevel: 'HIGH' | 'LOW' | 'TEMPORARILY_OUT_OF_STOCK' | 'UNKNOWN';
  fulfillment: { instore: boolean; curbside: boolean; delivery: boolean; shiptohome: boolean };
  allergens: string[]; imageUrl: string | null; cacheUntil: string; // ISO; from response cache headers
}
export interface CartItemDelta { productId: string; upc: string | null; quantityDelta: number; modality: Modality; }
export interface CartResult { accepted: CartItemDelta[]; rejected: { item: CartItemDelta; reason: string }[]; }
export interface Cart { items: { productId: string; quantity: number; modality: Modality }[]; fetchedAt: string; }
export interface Slot { id: string; start: string; end: string; modality: Modality; feeUsd: number | null; }
export interface Order { id: string; placedAt: string; totalUsd: number; status: string; }
export interface ConnectionHandle { connectionId: string; retailer: RetailerId; storeId: string | null; }

export interface RetailerAdapter {
  id: RetailerId;
  capabilities: Capabilities;
  connect(ctx: { householdId: string; userId: string; redirectUri: string; banner?: 'qfc' | 'fredmeyer' }): Promise<{ authorizeUrl?: string; handle?: ConnectionHandle }>;
  findStores(zip: string, opts?: { radiusMiles?: number }): Promise<Store[]>;
  searchProducts(q: string, store: Store, opts?: { limit?: number; brand?: string }): Promise<Product[]>;
  getProducts(ids: string[], store: Store): Promise<Product[]>;
  getCart?(conn: ConnectionHandle): Promise<Cart>;
  addToCart(conn: ConnectionHandle, items: CartItemDelta[]): Promise<CartResult>;
  removeFromCart?(conn: ConnectionHandle, itemIds: string[]): Promise<void>;
  getSlots?(conn: ConnectionHandle, store: Store, modality: Modality): Promise<Slot[]>;
  selectSlot?(conn: ConnectionHandle, slot: Slot): Promise<void>;
  checkout?(conn: ConnectionHandle, policy: unknown): Promise<{ orderRef: string }>;
  getOrders?(conn: ConnectionHandle): Promise<Order[]>;
}
```

- Kroger capabilities: `{ search: 'api', cartAdd: 'api', cartRead: 'none', slots: 'handoff', checkout: 'handoff', orders: 'none' }`.
- Mock capabilities: all `'api'` so WS09 can test every path.
- Tables (from `docs/02-data-model.md`): `retailer_connections (id, household_id, user_id, retailer, auth_type oauth|browser_session|none, vault_secret_id, store_id, store_name, modality, status, last_verified_at)`; `product_matches (id, household_id, retailer, store_id, ingredient_id, product_id, upc, product_name, size, confidence, chosen_by agent|user, pinned, last_chosen_at)`. New: `retailer_quota_usage (retailer, endpoint, day, count)` maintained by the worker and Edge Functions to stay under quota.
- `packages/core` additions: `RetailerId`, `Modality` enums re-exported for schemas.

**Consumes**
- `packages/db` generated types; `supabase-js` service role in the Edge Function; Supabase Vault (`vault.create_secret`, `vault.decrypted_secrets`).
- Kroger endpoints: authorize `https://api.kroger.com/v1/connect/oauth2/authorize`, token `https://api.kroger.com/v1/connect/oauth2/token`, `GET /v1/locations`, `GET /v1/locations/{id}`, `GET /v1/chains`, `GET /v1/products`, `GET /v1/products/{id}`, `PUT /v1/cart/add`, `GET /v1/identity/profile`.

**Kroger implementation rules (from the published API and terms)**
- Catalog calls use `client_credentials` with scope `product.compact`; cart calls use the user's `authorization_code` token with scope `cart.basic:write`; PKCE S256 on the authorize step; `banner` param set from the household's primary store chain.
- Access tokens last 30 minutes; refresh tokens last 6 months and are reissued on every refresh. Store only the refresh token, in Vault. Keep access tokens in memory for the life of a run.
- `GET /v1/products` requires `filter.term` (3+ chars, at most 8 words) or `filter.productId` (up to 50 comma-separated); always send `filter.locationId` so price, promo, aisle, fulfillment, and `stockLevel` come back; `filter.limit` ≤ 50, `filter.start` ≤ 250.
- `PUT /v1/cart/add` body `{ "items": [{ "upc": "<13 digits>", "quantity": n, "modality": "PICKUP" | "DELIVERY" }] }`, returns 204. Add-only. A negative `quantity` reduces. There is no read, so `getCart` is absent and `cartRead` is `'none'`.
- Quotas: Products 10,000/day, Cart 5,000/day, Identity 5,000/day, Locations 1,600/day per endpoint. `quota.ts` increments `retailer_quota_usage` and throws `RetailerQuotaError` at 95% so callers degrade before a 429.
- `cache.ts` honors `Cache-Control`/`Expires` only. No TTL of our own. `Product.cacheUntil` carries the header value so callers know when a price is stale.
- `terms.ts` exports `assertDisplayUnchanged(product)` used by UI components to render `name`, `description`, `price`, and images exactly as returned, uncropped, no overlays.
- Nothing from a search response is written to a table. `product_matches` is written only when a user confirms a choice, and only the allowed columns.
- The certification host `https://api-ce.kroger.com/v1/` has no customer accounts. Cart and Identity are tested in production with the developer's own Kroger account behind `KROGER_LIVE_TEST=1`.

## Acceptance criteria
1. `pnpm typecheck` passes with `RetailerAdapter` exported from `packages/retailers` and consumed by `apps/mobile` without `any`.
2. `MockRetailer.test.ts`: search returns deterministic results for a seed, `addToCart` then `getCart` reflects quantities, configured failure mode throws the typed error.
3. `auth.test.ts`: builds an authorize URL containing `scope=cart.basic%3Awrite`, `code_challenge_method=S256`, and `banner=qfc` for a QFC primary store; exchanges a recorded code response and stores only the refresh token via a mocked Vault call.
4. `products.test.ts`: `searchProducts('chicken thighs', store)` sends `filter.term`, `filter.locationId`, `filter.limit=50`; maps a recorded response to `Product` with `price`, `promoPrice`, `stockLevel`, `fulfillment`, `allergens`, and `cacheUntil` derived from the recorded `Cache-Control: max-age`.
5. `products.test.ts`: `getProducts()` with 60 IDs issues two requests of 50 and 10.
6. `cart.test.ts`: `addToCart` sends `PUT /v1/cart/add` with 13-digit UPCs and `modality` from the connection; a `quantityDelta` of -1 is sent as `quantity: -1`; a 401 triggers one refresh and one retry, then `RetailerAuthError`.
7. `quota.test.ts`: the 9,501st Products call in a day throws `RetailerQuotaError` without hitting the network.
8. `cache.test.ts`: a second identical search inside `max-age` does not call the network; one second after expiry it does.
9. `terms.test.ts`: rendering a product with a modified `name` fails `assertDisplayUnchanged`.
10. `supabase test db` passes `ws07_retail_rls.sql`: a user in household A cannot select household B's `retailer_connections` or `product_matches`; `vault_secret_id` is never readable via the anon or authenticated role.
11. The OAuth Edge Function, given a recorded callback, creates one `retailer_connections` row with `auth_type='oauth'`, `status='active'`, and a non-null `vault_secret_id`; calling disconnect deletes the Vault secret and sets `status='revoked'`.
12. With `KROGER_LIVE_TEST=1` and real credentials, the live smoke test finds at least one store for ZIP 98019, searches "milk", and adds one item to the developer's own cart, returning 204. This test is skipped in CI.
13. In the dev catalog explorer on the iOS Simulator, a connected account can search, see prices for the chosen store, tap "Add", and then open kroger.com/checkout in the system browser and see the item in the cart. Record a screenshot path in the completion report.
14. `grep -r "last_price\|price" supabase/migrations/*ws07*` shows no price column on `product_matches`.
15. `pnpm lint` passes; no file under `packages/retailers` imports from `apps/` or `services/`.

## Verification commands
```bash
pnpm typecheck && pnpm lint                                   # expected: exit 0
pnpm test --filter retailers                                  # expected: mock, auth, products, cart, quota, cache, terms tests green
supabase start && supabase db reset                           # expected: ws07 migration applies; Vault extension present
supabase test db                                              # expected: ws07_retail_rls.sql passes
supabase functions serve retailer-oauth --env-file .env.local # manual: complete the OAuth round trip from the app
KROGER_LIVE_TEST=1 pnpm test --filter retailers -- kroger.live # expected (local only): store found, search ok, cart add 204
pnpm --filter mobile start                                    # manual: Connect Kroger → store picker → (dev) catalog → Add → open checkout
```

## Risks and notes
- From the WS00 review (2026-10-30): never set `meta: { persist: true }` on a TanStack query that returns Kroger data. The WS00 persisted cache keeps opted-in queries for up to 24 hours regardless of `cacheUntil`, which would break the Kroger cache-header rule. Keep catalog data in memory only, bounded by the response's cache headers.
- R15: quotas are shared across every household on one client ID. Batch pinned items through `filter.productId`, search only unpinned items, and surface `RetailerQuotaError` to WS09 so it can pause a run instead of failing it.
- R21: Kroger forbids storing data derived from searches or cart adds and forbids caching past headers. This WS is where that rule becomes code: no table receives search results; `product_matches` has no price or stock; `Product.cacheUntil` is the only cache signal. The orchestrator will seek written clarification from Kroger before any public launch; design so a stricter reading still works.
- R22: banner logos (QFC, Fred Meyer) may appear only in the Add-to-Cart UI and only while the app is not monetized. Put logo usage behind a single `showBannerLogos` flag defaulting to true for the household build and document the Partnership Request requirement in the component.
- R13: `Product.id` and `upc` come from the API; nothing upstream may invent them. Export a `ProductRef` type that WS09 must use for agent tool outputs.
- Kroger's own site runs on Akamai; this WS never touches kroger.com except by opening the checkout URL in the system browser for the user.
- Inventory and fulfillment flags mean "approved for," not "in stock." Label them accordingly in the UI.
- The redirect URI must be an app deep link (`souvie://oauth/kroger`) registered in the Kroger app settings; the Edge Function handles the server side exchange so the client secret never ships in the app bundle.
- Testing cart in production only: use a dedicated developer Kroger account and keep `KROGER_LIVE_TEST` off in CI.

## Completion report
End with the report format from `docs/implementation-guide.md` §6.2 (Message templates) (Built, Files changed, Verification output, Deviations from brief, Contract change requests, Open issues, Follow-ups). Nothing else is read by the orchestrator.

## Web sign-in round (orchestrator, 2026-11-01): connect a Kroger account from the web app

Miguel tests on the web at http://localhost:8081, and a schedule needs a store connection, but Kroger sign-in only works from the phone app: `retailer-oauth` builds the authorize URL from the single `KROGER_REDIRECT_URI` secret (the `souvie://oauth/kroger` deep link registered with Kroger), and `ConnectKroger.tsx` on the web shows only "Connect your {store} account from the iOS or Android app." This round adds a web path. Branch `ws/07b-web-connect`, Sonnet.

In scope:
1. **An allowlist of redirect URIs on the function.** A new optional secret `KROGER_WEB_REDIRECT_URIS`, a comma-separated list of exact `https://` or `http://localhost` URLs ending in `/oauth/kroger` (for example `http://localhost:8081/oauth/kroger`). `authorize` accepts an optional `redirectUri` in its body; it must equal `KROGER_REDIRECT_URI` or one entry of the allowlist, compared exactly after trimming, or the action fails with `invalid_request`. The chosen URI is bound into the server-side state so `exchange` uses the same one for the token call (Kroger requires the same `redirect_uri` on both legs); `exchange` therefore takes no `redirectUri` from the client. With no `redirectUri` in the body the deep link is used, so the phone flow is unchanged. `KrogerAdapter.connect` already takes `redirectUri`; if the token exchange in `packages/retailers/src/kroger/` needs the URI threaded through, that edit is authorized (not `types.ts`, not `registry.ts`).
2. **The web connect control.** `ConnectKroger.tsx` on `Platform.OS === "web"` shows the same Connect button as native. It calls `authorize` with `redirectUri` built from `window.location.origin + "/oauth/kroger"`, then navigates the page to `authorizeUrl` (a full-page `window.location.assign`; no popup, no iframe). Before navigating, assert the URL's host is Kroger's (`api.kroger.com` or the `KROGER_API_BASE` host the function reports); never navigate to an arbitrary URL. The Supabase web session must survive the round trip (it lives in local storage; verify).
3. **The web callback.** `apps/mobile/app/oauth/kroger.tsx` already exists and runs `completeKrogerRedirect`, which calls `exchange` with `code` and `state`; make sure it works on the web (query parameters from the full URL, the `SessionGuard` restoring the session after the redirect, a one-time use of the code, `router.replace` to the Stores section or the planner when there is no history). On an error show the existing "Kroger is not connected" screen.
4. **Stores screen on the web.** Wherever `ConnectKroger` renders (`KrogerSettingsSection.tsx` in household settings, onboarding screen 7), the web now offers the button and, after the connection lands, the connection card with its store and Disconnect, like native.
5. **Tests.** Handler tests: an unlisted `redirectUri` is refused; a listed one is bound into the state and used by `exchange`; a state created with one URI cannot be exchanged with another; no `redirectUri` means the deep link; a `KROGER_WEB_REDIRECT_URIS` entry that is not exact (trailing slash, different port, `http://` on a non-localhost host) is ignored at parse time with a logged warning. App tests: the web branch renders the button, builds the redirect from the origin, refuses a non-Kroger `authorizeUrl`, and the callback route completes once. One Playwright spec in `e2e-web/` against the fake Supabase (stub the function's `authorize` and `exchange`): click Connect on the Stores screen, land on the fake Kroger page, return to `/oauth/kroger?code&state`, see the connection card. The spec must import `test` from `e2e-web/support/test.ts`.
6. **Docs and config.** `.env.example` gains `KROGER_WEB_REDIRECT_URIS` with a comment; `supabase/functions/retailer-oauth/README.md` and docs/01's deep-links paragraph describe the web path; docs/04's Kroger section notes that the developer app must list every redirect URL.

Out of scope: any other retailer, the Tier 3 host, `packages/retailers/src/types.ts` and `registry.ts`, `packages/core`, migrations, the desktop shell (the Tauri app opens only https links in the system browser; a desktop path is a follow-up).

Acceptance: `corepack pnpm typecheck && corepack pnpm lint && corepack pnpm test` clean; `corepack pnpm exec biome check .` clean; the function's `deno check` passes in CI; the e2e spec passes with the suite; mutation evidence for the allowlist (remove the exact-match check, the state binding, the host assertion: each red); CI green on the pushed head. After merge the orchestrator deploys `retailer-oauth`, sets `KROGER_WEB_REDIRECT_URIS=http://localhost:8081/oauth/kroger`, and Miguel adds the same URL to the Kroger developer app; then Connect QFC on the web creates the connection. End with the §6.2 completion report and nothing else.
