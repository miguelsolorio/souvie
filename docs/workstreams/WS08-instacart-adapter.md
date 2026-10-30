# WS08: Instacart adapter

**Wave:** 3 · **Suggested model:** Sonnet · **Branch:** `ws/08-instacart-adapter`

## Goal
When this is done, a household whose list includes items destined for Costco, Safeway, Albertsons, Haggen, or any other Instacart-served store can tap one button per store and land on an Instacart-hosted shopping-list page with their items already matched and the right store preselected. Instacart's Developer Platform self-serve tier offers exactly two capabilities, creating a shoppable recipe page and creating a shopping-list page, each returning a URL. There is no cart read or write, no order, no slot selection, and no price data back to us. So this adapter is a hand-off adapter: it converts our aggregated list into Instacart line items, creates the page, and sends the user through. It is the Tier 2 route for every store that has no direct API.

## Depends on
- WS07 (Retailer framework): the `RetailerAdapter` contract, `Store`, `Product`, registry, typed errors, `retailer_connections` table.
- WS05 (Grocery list) is NOT required to merge first, but this adapter consumes `grocery_list_items` shapes from `docs/02-data-model.md`. Build against the table definition and fixtures.
- Human checkpoint 4: the Instacart Developer Platform application status is known. A development API key works immediately against the dev host with no approval; a production key is issued only after Instacart's review (about 30 to 40 days, requires a demo). On 2026-10-29 Instacart's marketing page said it was not accepting new applications while the docs still said "Apply today." If no key exists, build and test fully against a recorded dev-host fixture and mark the live test skipped.

## Read first
1. `docs/04-integrations.md` §5.2 Instacart block (endpoints, line-item schema, terms), §5.3, §5.4 row for `instacart`.
2. `docs/02-data-model.md` Lists and Retail sections (`grocery_list_items`, `retailer_connections`).
3. `docs/06-risks.md` rows R14, R18, R20.
4. `packages/retailers/src/types.ts` and `registry.ts` from WS07.

## In scope
- `packages/retailers/src/instacart/InstacartAdapter.ts` implementing `RetailerAdapter` with capabilities `{ search: 'none', cartAdd: 'handoff', cartRead: 'none', slots: 'handoff', checkout: 'handoff', orders: 'none' }`.
- An HTTP client for the Developer Platform with `INSTACART_ENV` switching between `https://connect.dev.instacart.tools` and `https://connect.instacart.com`, bearer `INSTACART_API_KEY`.
- `GET /idp/v1/retailers?postal_code=<zip>&country_code=US` → `Store[]` (fields `retailer_key`, `name`, `retailer_logo_url`), cached per ZIP for the response's cache lifetime only.
- `POST /idp/v1/products/products_link` (shopping list) and `POST /idp/v1/products/recipe` (recipe page) request builders and response parsing (`products_link_url`).
- A list-to-line-items mapper in `packages/retailers/src/instacart/mapper.ts` that turns `grocery_list_items` into Instacart line items: generic `name` without brand or quantity words, `display_text` as the human label, `line_item_measurements: [{ quantity, unit }]` using only Instacart's supported unit list, optional `upcs` when a pinned `product_matches` row has one, optional `filters.brand_filters` from pinned brand, optional `filters.health_filters` from diet preferences (`ORGANIC`, `GLUTEN_FREE`, `VEGAN`, `KOSHER`, `SUGAR_FREE`, `LOW_FAT`, `FAT_FREE`).
- Store preselection by appending `?retailer_key=<key>` to the returned URL, behind a flag `INSTACART_PRESELECT_SUPPORTED` that the live test flips to true once confirmed.
- `landing_page_configuration.partner_linkback_url` set to our deep link so the user returns to the app after checkout; `expires_in` set to 30 days.
- UI in `apps/mobile/features/retailers/instacart/`: a per-store "Shop with Instacart" button using Instacart's required CTA styling, a "what happens next" sheet (you will finish on Instacart), and a Costco notice when `profiles.costco_member` is false (members shop through sameday.costco.com; non-members pay more on instacart.com and have a $35 minimum).
- `retailer_connections` row with `auth_type = 'none'` per household per Instacart store, so the agent and UI can treat Instacart stores like any other connection.
- Unit tests with recorded fixtures; one opt-in live test behind `INSTACART_LIVE_TEST=1`.
- A terms checklist test and a doc section proving compliance before the orchestrator ships this.

### Mapping examples (list item → Instacart line item)

| List item (`display_name`, `qty`, `unit`) | Pinned match | `name` | `display_text` | `line_item_measurements` | Extras |
|---|---|---|---|---|---|
| Yellow onions, 3, each | none | `yellow onion` | `Yellow onions, 3 medium` | `[{quantity: 3, unit: "each"}]` | none |
| Chicken thighs boneless skinless, 2, lb | none | `chicken thighs` | `Chicken thighs, boneless skinless, 2 lb` | `[{quantity: 2, unit: "lb"}]` | none |
| Cheddar cheese, 8, oz | Tillamook, UPC 072830… | `cheddar cheese` | `Tillamook sharp cheddar, 8 oz` | `[{quantity: 8, unit: "oz"}]` | `upcs: ["0728300…"]` |
| Pasta, 1, lb (household diet gluten_free) | none | `pasta` | `Gluten-free pasta, 1 lb` | `[{quantity: 1, unit: "lb"}]` | `filters.health_filters: ["GLUTEN_FREE"]` |
| Fresh basil, 1, bunch | none | `basil` | `Fresh basil, 1 bunch` | `[{quantity: 1, unit: "bunch"}]` | unit confirmed in `units.ts` |
| Olive oil, 0.25, cup | none, pantry excluded | skipped | skipped | skipped | `excluded_reason = pantry` items are never sent |

Rules the mapper follows: strip brand, quantity, and size words from `name`; keep them in `display_text`; never send both `upcs` and `product_ids`; drop `health_filters` when a UPC is present (Instacart ignores them anyway); skip items whose `excluded_reason` is set; group by store so one request holds one store's items.

### Hand-off UX states

| State | What the user sees | Data written |
|---|---|---|
| Idle | "Shop with Instacart" button per Instacart-served store on the list | none |
| Creating | Button spinner, under 3 seconds | none |
| Ready | Hand-off sheet: store name, item count, "You will finish on Instacart. Prices and availability show there." Primary action opens the link | `shopping_runs` row with `status = cart_ready`, `cart_snapshot.handoffUrl`, `cart_snapshot.expiresAt` |
| Returned | App reopened via `partner_linkback_url`: "Did you place the order?" Yes writes an `orders` row with user-entered total; Not yet keeps the run open | `orders` (optional), `shopping_runs.status` |
| Expired | After `expires_in`, the button regenerates the link | new `cart_snapshot.handoffUrl` |
| Costco non-member | Notice above the Costco button explaining member pricing and the $35 minimum, with "Continue anyway" | none |

## Out of scope
- Any attempt to read Instacart carts, prices, or orders. The self-serve tier has none; the partner MCP tier ("contact your representative") is a business task for the human, tracked in `docs/09-open-questions.md`.
- Browser automation on instacart.com, costco.com, or safeway.com (WS10).
- The grocery list aggregation itself (WS05) or line-item scoring for Kroger (WS09).
- Affiliate program setup on Impact.com. Note it as a follow-up; do not add tracking links.
- Showing Instacart items with prices next to Kroger items. Instacart's terms forbid priced items from multiple retailers on one screen, and we get no Instacart prices anyway.

## Deliverables
- `packages/retailers/src/instacart/InstacartAdapter.ts`, `client.ts`, `mapper.ts`, `units.ts` (supported unit list and conversions from our canonical units), `terms.ts`.
- `packages/retailers/src/instacart/__fixtures__/retailers_98019.json`, `products_link_response.json`, `recipe_response.json`.
- `packages/retailers/src/instacart/*.test.ts` (adapter, mapper, units, terms).
- `apps/mobile/features/retailers/instacart/ShopWithInstacartButton.tsx`, `InstacartHandoffSheet.tsx`, `CostcoMembershipNotice.tsx`, `useInstacartLink.ts`.
- `supabase/functions/instacart-link/index.ts`: server-side creation of the page so the API key never ships in the app bundle; input `{ listId, storeRetailerKey }`, output `{ url, expiresAt }`.
- `.env.example` additions: `INSTACART_API_KEY`, `INSTACART_ENV`, `INSTACART_PRESELECT_SUPPORTED`.
- Docs update: `docs/04-integrations.md` §5.4 row for `instacart` gets an "Implemented" note; `docs/09-open-questions.md` records whether `retailer_key` preselection worked against the dev key.

## Interfaces
**Implements**
- `InstacartAdapter: RetailerAdapter` with:
  - `connect()` returns a `ConnectionHandle` immediately (no OAuth); writes `retailer_connections` with `auth_type='none'`, `store_id = retailer_key`.
  - `findStores(zip)` → `Store[]` from `GET /idp/v1/retailers`.
  - `searchProducts()` and `getProducts()` throw `RetailerNotSupportedError`.
  - `addToCart(conn, items)` is repurposed as the hand-off: it accepts `CartItemDelta[]` plus list context and returns `CartResult` whose `accepted` list is every item sent and whose metadata carries the `products_link_url`. Document this clearly in JSDoc; WS09 reads `capabilities.cartAdd === 'handoff'` and opens the URL instead of expecting a cart.
- `createShoppingListLink(input: { title: string; items: InstacartLineItem[]; retailerKey?: string; linkbackUrl: string; expiresInDays?: number }) => Promise<{ url: string; expiresAt: string }>`.
- `createRecipeLink(input: { title: string; imageUrl?: string; instructions?: string[]; ingredients: InstacartLineItem[]; enablePantryItems?: boolean; retailerKey?: string; linkbackUrl: string }) => Promise<{ url: string; expiresAt: string }>`.
- `InstacartLineItem`:
  ```ts
  interface InstacartLineItem {
    name: string;                       // generic, no brand, weight, or count words
    display_text?: string;              // what the user sees, e.g. "Yellow onions, 3 medium"
    line_item_measurements?: { quantity: number; unit: string }[];
    upcs?: string[];                    // 12 or 14 digit, ordered fallbacks; mutually exclusive with product_ids
    product_ids?: string[];
    filters?: { brand_filters?: string[]; health_filters?: ('ORGANIC'|'GLUTEN_FREE'|'FAT_FREE'|'VEGAN'|'KOSHER'|'SUGAR_FREE'|'LOW_FAT')[] };
  }
  ```
- Edge Function `POST /functions/v1/instacart-link` as above.
- Example shopping-list request body the client builds (dev host):
  ```json
  {
    "title": "Week of Nov 2 · Safeway Duvall",
    "link_type": "shopping_list",
    "expires_in": 30,
    "line_items": [
      { "name": "yellow onion", "display_text": "Yellow onions, 3 medium", "line_item_measurements": [{ "quantity": 3, "unit": "each" }] },
      { "name": "chicken thighs", "display_text": "Chicken thighs, boneless skinless, 2 lb", "line_item_measurements": [{ "quantity": 2, "unit": "lb" }] },
      { "name": "cheddar cheese", "display_text": "Tillamook sharp cheddar, 8 oz", "line_item_measurements": [{ "quantity": 8, "unit": "oz" }], "upcs": ["072830012345"] }
    ],
    "landing_page_configuration": { "partner_linkback_url": "mealplanner://instacart/return?runId=<id>" }
  }
  ```
  Response: `{ "products_link_url": "https://www.instacart.com/store/shopping_lists/<id>" }`. The client appends `?retailer_key=safeway` only when `INSTACART_PRESELECT_SUPPORTED=true`.

**Consumes**
- `grocery_list_items (id, list_id, ingredient_id, display_name, qty, unit, section, checked, excluded_reason)`, `ingredients (name, category)`, `product_matches (upc, product_name, pinned)` for the mapper.
- `profiles.costco_member` for the Costco notice.
- Instacart endpoints listed above; the deprecated `quantity`/`unit` top-level fields (removed March 18, 2026) must not be sent.

**Terms encoded in `terms.ts` and enforced by tests**
- One link per store; never combine stores in one request or one screen with prices.
- The CTA renders Instacart's required button text and colors from their pre-launch checklist; copy never says "partner" or "Free Delivery."
- No caching of Instacart responses beyond headers; no persisting of anything Instacart returns except the link URL and expiry on `shopping_runs` for the run's lifetime.
- Data deletion: a `deleteInstacartData(householdId)` function removes stored links within 5 business days of a request, exposed for the privacy tooling.

## Acceptance criteria
1. `pnpm typecheck && pnpm lint` pass; `InstacartAdapter` registers under `getAdapter('instacart')` with the exact capabilities row above.
2. `mapper.test.ts`: "2 lb boneless skinless chicken thighs" from a list item becomes `{ name: "chicken thighs", display_text: "Chicken thighs, boneless skinless, 2 lb", line_item_measurements: [{ quantity: 2, unit: "lb" }] }`; "Tillamook cheddar" with a pinned UPC emits `upcs` and omits `product_ids`; a diet of `gluten_free` adds `GLUTEN_FREE` to `health_filters` only when no UPC is set.
3. `units.test.ts`: our canonical units map to Instacart-supported units; an unsupported unit falls back to `each` with the original text kept in `display_text`.
4. `adapter.test.ts`: `createShoppingListLink` posts to the dev host when `INSTACART_ENV=dev`, sends bearer auth, sets `landing_page_configuration.partner_linkback_url`, sets `expires_in = 30`, and returns the recorded `products_link_url`; with `retailerKey` and `INSTACART_PRESELECT_SUPPORTED=true` the URL ends with `?retailer_key=costco`.
5. `adapter.test.ts`: duplicate UPCs in one request are rejected client-side before any network call (Instacart returns 400 for them).
6. `terms.test.ts`: a request containing two different `retailerKey` values fails; a CTA component rendered with the word "partner" fails the copy lint.
7. `findStores('98019')` maps the recorded response to `Store[]` with `id = retailer_key`.
8. The Edge Function `instacart-link` rejects calls where the caller is not a member of the list's household (RLS test `supabase/tests/ws08_instacart.sql`).
9. On the iOS Simulator, a list with ten items and a Safeway store shows one "Shop with Instacart" button; tapping it shows the hand-off sheet, then opens the system browser on an Instacart URL. Record the URL (dev host) in the completion report.
10. A household with `costco_member = false` sees the Costco membership notice before the Costco button; a member does not.
11. `grep -rn '"quantity":' packages/retailers/src/instacart/` finds no top-level `quantity` field in request builders.
12. With `INSTACART_LIVE_TEST=1` and a dev key, the live test creates a real dev-host link and opens it to confirm the store is preselected; the test writes the result to `docs/09-open-questions.md` via a printed instruction, not automatically.

## Verification commands
```bash
pnpm typecheck && pnpm lint                              # expected: exit 0
pnpm test --filter retailers -- instacart                # expected: adapter, mapper, units, terms tests green
supabase start && supabase db reset && supabase test db  # expected: ws08_instacart.sql passes
supabase functions serve instacart-link --env-file .env.local &
curl -s -X POST http://localhost:54321/functions/v1/instacart-link \
  -H "Authorization: Bearer $TEST_USER_JWT" -H "Content-Type: application/json" \
  -d '{"listId":"<fixture>","storeRetailerKey":"safeway"}' | jq .url   # expected: a connect.dev.instacart.tools URL
INSTACART_LIVE_TEST=1 pnpm test --filter retailers -- instacart.live    # expected (local, dev key): link created; preselect result printed
pnpm --filter mobile start                               # manual: list → Shop with Instacart → sheet → browser
```

## Risks and notes
- R14: Instacart may not be accepting applicants. Development continues on the dev host; production hand-off is blocked until a production key exists. If the application is refused, Costco and Safeway fall to Tier 3 (WS10). Flag this clearly in the status ledger notes.
- R18: terms violations are the fastest way to lose the key. The three rules that matter: no priced items from multiple retailers on one screen (we show no Instacart prices at all), no moving or comparing items between retailer baskets, and the required Instacart CTA with no "partner" or "Free Delivery" wording. Instacart data is confidential and deletable within 5 business days.
- R20: Costco on Instacart is members-only via sameday.costco.com; non-members can use instacart.com at higher prices with a $35 minimum. Route by `profiles.costco_member`.
- Store preselection via `?retailer_key=` appears in Instacart's tutorial but one researcher could not find it in the API reference. Treat it as unconfirmed until the live test proves it; the flag defaults to false.
- Rate limits are undocumented. Add exponential backoff on 429 and surface `RetailerQuotaError`.
- The Instacart landing page does product matching itself; unmatched-item behavior is undocumented. Set `display_text` carefully and keep `name` generic so matching has the best chance.
- The affiliate program (Impact.com) is optional and a human business task. Leave a TODO in the completion report, not in code.

## Completion report
End with the report format from `docs/implementation-guide.md` §6.2 (Message templates) (Built, Files changed, Verification output, Deviations from brief, Contract change requests, Open issues, Follow-ups). Nothing else is read by the orchestrator.
