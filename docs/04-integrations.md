# 04 · Integrations

Research collected 2026-10-29 from primary sources (developer portals, official docs, terms of service, press releases, court records). Facts that could not be confirmed are in `09-open-questions.md`.

## The hard constraint

No API from Kroger, Albertsons, Costco, or Instacart's self-serve tier, and no agentic-commerce protocol, lets a third party pay or select a pickup or delivery window today. Every official path ends with the user tapping "place order" in the retailer's own app or site. That makes Tier 1 ("fill the cart, the user pays") the main line and Tier 3 (browser automation) the only route to true hands-off checkout.

## Feasibility matrix

| Retailer | Product search | Add to cart | Checkout / pay | Pick a slot | Order history |
|---|---|---|---|---|---|
| QFC / Fred Meyer | **Direct API** (Kroger Products) | **Direct API** (Kroger Cart, add-only) | User completes at kroger.com/checkout or in the banner app (Tier 1) · Tier 3 browser | User in app · Tier 3 browser | Not in public tier; we record from our run ledger |
| Safeway / Albertsons / Haggen | Via Instacart link (no data back) · Tier 3 browser | Via Instacart link · Tier 3 browser | User completes on Instacart or Safeway · Tier 3 browser | User in app · Tier 3 browser | Not possible via API; ledger |
| Costco | Via Instacart link (members use sameday.costco.com) · Tier 3 browser | Via Instacart link · Tier 3 browser | User completes on Instacart · Tier 3 browser | User in app (delivery only on Instacart in Seattle) · Tier 3 browser | Not possible via API; ledger |

## Adapter contract (`packages/retailers`)

```ts
export type Capability = 'api' | 'browser' | 'handoff' | 'none';

export interface Product {
  id: string;            // retailer product id
  upc?: string;
  name: string;          // displayed exactly as returned (Kroger terms)
  brand?: string;
  size?: string;
  price?: number;        // regular, USD
  promoPrice?: number;
  stockLevel?: 'HIGH' | 'LOW' | 'TEMPORARILY_OUT_OF_STOCK' | 'UNKNOWN';
  fulfillment?: { instore?: boolean; curbside?: boolean; delivery?: boolean; shiptohome?: boolean };
  allergens?: string[];
  imageUrl?: string;
  cacheUntil: Date;      // from response cache headers; never persisted past this
}

export interface CartItemDelta { productId?: string; upc?: string; quantityDelta: number; modality?: 'PICKUP' | 'DELIVERY' }

export interface RetailerAdapter {
  id: 'kroger' | 'instacart' | 'safeway' | 'costco';
  capabilities: {
    search: Capability; cartAdd: Capability; cartRead: Capability;
    slots: Capability; checkout: Capability; orders: Capability;
  };
  connect(ctx: ConnectContext): Promise<ConnectionHandle>;        // OAuth, or browser session capture
  findStores(zip: string): Promise<Store[]>;
  searchProducts(q: string, store: Store, opts?: SearchOpts): Promise<Product[]>;
  getProducts(ids: string[], store: Store): Promise<Product[]>;    // batch for pinned items
  getCart?(conn: ConnectionHandle): Promise<Cart>;                 // absent when cartRead is 'none'
  addToCart(conn: ConnectionHandle, items: CartItemDelta[]): Promise<CartResult>;
  removeFromCart?(conn: ConnectionHandle, itemIds: string[]): Promise<void>;
  getSlots?(conn: ConnectionHandle, store: Store, modality: 'PICKUP' | 'DELIVERY'): Promise<Slot[]>;
  selectSlot?(conn: ConnectionHandle, slot: Slot): Promise<void>;
  checkout?(conn: ConnectionHandle, policy: RunPolicy): Promise<OrderRef>;   // Tier 3 only, gated
  getOrders?(conn: ConnectionHandle): Promise<Order[]>;
  handoffUrl?(conn: ConnectionHandle, run: RunContext): Promise<string>;    // deep link for Tier 1/2
}
```

**As built (WS07).** The contract lives in `packages/retailers/src/types.ts` and differs from the sketch above in these ways. Optional fields are explicit nulls (`upc: string | null`), and `cacheUntil` is an ISO string so a `Product` survives JSON. `Product` adds `soldBy` (`UNIT` or `WEIGHT`), which the scorer needs for unit-price fit, `mayContain`, the subset of `allergens` declared only as "may contain", and `undeclared`, the subset Kroger lists as "Undeclared" (`allergens` stays the conservative list safety checks read; "Free from" and "Not intentionally nor inherently included" are dropped). `connect` returns `{ authorizeUrl?, handle? }`: OAuth adapters return the URL, the mock returns a handle at once. `ConnectionHandle` carries the connection's `modality`, and `CartItemDelta.modality` falls back to it, then to PICKUP. `checkout` takes `policy: unknown` until WS09 defines `RunPolicy`. `handoffUrl` is kept. The registry (`getAdapter`, `isAdapterAvailable`, `listAdapters`), the typed errors, the capability table, and `ProductRef` are exported from `@mp/retailers`. Adapters sit behind `@mp/retailers/kroger` and `@mp/retailers/mock`, so the app bundle never carries them. `RETAILER_IDS` and `MODALITIES` come from `@mp/core` (`RetailerId`, `AdapterModality`).

The agent and the UI only ever see this contract. Adding a store is a new adapter plus a capabilities row. The UI renders what each store can do ("Cart fills automatically, you pay in the QFC app"). API adapters run in the worker; browser adapters run wherever the browser is (client WebView in Mode A, household-hosted worker in Mode B), so `packages/agent` has no Node-only dependencies. `mock/` ships a `MockRetailer` with fixtures for tests, evals, and replays.

## Per-retailer adapter plan

| Adapter | Tier | Capabilities | Notes | Implemented |
|---|---|---|---|---|
| `kroger` | 1 | search api · cartAdd api · cartRead none · slots handoff · checkout handoff · orders none | First and best adapter. OAuth with PKCE and the `banner` parameter during onboarding. Idempotency via the run ledger, not cart reads. Live product lookups every run; nothing cached past response headers. Deep link to kroger.com/checkout or the QFC or Fred Meyer app. Cart calls can only be tested in production | WS07, 2026-10-30. `packages/retailers/src/kroger/`. OAuth with PKCE S256, a sealed state, and the banner; refresh tokens in Vault, rotated on every refresh. Locations, Products search and batch lookup, Cart add. Daily counts in `retailer_quota_usage`, stopping at 95%. Cache bounded by response headers only; Kroger sends none, so nothing is cached. The terms guard keeps no product data: only a salted hash of each received product's id and display fields, dropped at `cacheUntil` or, with no cache header, when the screen releases the results. Per-member hourly limits in `retailer-oauth` protect the shared quota. Live-tested for stores and search; the cart call waits on the developer's own token |
| `instacart` | 2 | search none · cartAdd handoff · cartRead none · slots handoff · checkout handoff · orders none | One shopping-list link per store. Preselect the store with `?retailer_key=` (confirm with a dev key). Apply for the production key in Phase 0. Show the required Instacart CTA | Not yet (WS08) |
| `safeway` (browser) | 3 | all browser | Mode A on-device first | Not yet (WS10) |
| `costco` (browser) | 3 | all browser | Mode A on-device first. Membership required | Not yet (WS10) |
| `kroger` browser extension | 3 | slots browser · checkout browser | Optional: finishes slot and pay after the API filled the cart | Not yet (WS10, optional) |

**Cross-store splitting** stays inside both Kroger's and Instacart's terms because the only prices we display come from the Kroger API (one retailer family), and other stores are assigned by household rules ("bulk and paper goods → Costco," "produce → QFC") and learned preferences, never by comparing prices across retailers on one screen.

## Kroger (QFC, Fred Meyer)

Portal: developer.kroger.com. Self-serve: create an account, register an app, receive client id and secret immediately. No fees stated; the terms say exceeding limits may require "additional terms and/or charges." A Partner tier (signed contract, no rate limits) adds full Carts CRUD, Catalog API V2, Seamless Delivery, and Unattended Locker Pickup.

### Endpoints (public tier)

| API | Auth | Quota | What |
|---|---|---|---|
| Locations | client credentials | 1,600/day per endpoint (3 endpoints) | Stores by ZIP or lat/long, chains, departments |
| Products | client credentials, scope `product.compact` | 10,000/day | `GET /v1/products` with `filter.term` (3+ chars, ≤8 words, fuzzy) or `filter.productId` (≤50 ids) or `filter.brand`. `filter.locationId` (8 chars) is required to receive `price.regular`, `price.promo`, `aisleLocations`, `fulfillment` flags (`instore`, `curbside`, `delivery`, `shiptohome`), and `inventory.stockLevel`. Also `upc`, `brand`, `description`, `categories`, `images[]`, `items[].size`, `soldBy`, `allergens`, `restrictions`, `productPageURI`, and a `nutritionInformation` field whose population is unconfirmed. `filter.limit` 1–50, `filter.start` ≤250, so ~300 results per query. Fulfillment flags mean "approved for," not "in stock"; inventory is confirmed only at Kroger checkout |
| Identity | authorization code, scope `profile.compact` | 5,000/day | Returns only the customer's profile id |
| Cart | authorization code, scope `cart.basic:write` | 5,000/day | **Add-only.** `PUT /v1/cart/add` with `{ items: [{ upc: '13-digit', quantity: int, modality: 'PICKUP' | 'DELIVERY' }] }` returns 204. No read, update, or delete. Reduce quantity by sending a negative number. Modality defaults to PICKUP |

### Auth

OAuth2 at `https://api.kroger.com/v1/connect/oauth2/authorize` and `/token`. Grant types `client_credentials`, `authorization_code`, `refresh_token`. PKCE S256 supported and recommended for native apps. Access tokens last 30 minutes; refresh tokens 6 months and are reissued on every refresh. `banner=qfc` or `banner=fredmeyer` on the authorize URL brands the consent screen. `cart.basic:write` cannot be used with client credentials.

### Environments

Production `https://api.kroger.com/v1/`. Certification `https://api-ce.kroger.com/v1/` has no customer accounts, so Cart and Identity can only be exercised in production. Credentials are locked to one environment.

### Checkout

Redirect the user to `https://www.kroger.com/checkout` or the banner's app. There are no order, payment, slot, coupon, or loyalty endpoints in the public tier.

### Terms that shape the product (developer terms 2019-04-09; acceptable use; branding 2021-04-28)

- Display product and location data "exactly as it is returned": no changes to name, description, or price; images uncropped, no overlays.
- No cached copies beyond the response cache header; no scraping or building a product database.
- No "tracking, sharing, or storing data derived from customer searches" or from items added to a cart. Cart display data "should be terminated when a user closes the application."
- Add to cart only items the customer "explicitly" requests.
- No "comparing products/prices among other retailers."
- Banner logos (QFC, Fred Meyer) only inside the Add-to-Cart UI and only while the app is not monetized. Monetized apps need a Partnership Request. The app name "cannot have Kroger anywhere." No implying partnership.
- A privacy policy and data portability are required.

How the design complies: `product_matches` stores only the user's confirmed product (ids, name, size); prices and stock are fetched live; `cart_snapshot` is cleared 24 hours after a run closes; no table stores search results; prices from other retailers are never shown beside Kroger prices. Before any public or monetized launch, get written clarification from Kroger on storing user-pinned preferences and run history (R21 in `06-risks.md`).

### Agentic surface

None for third parties. Kroger's own assistant runs on Google Cloud Gemini; Instacart's Cart Assistant is embedded in Kroger's iOS app; Kroger endorses Google's UCP ("food ordering coming soon"). Kroger sites embed Cooklist-powered assistants.

Sources: developer.kroger.com (api-products, documentation/public/getting-started/apis, support/faq, terms, acceptable-use, branding; portal is JavaScript-rendered), ir.kroger.com press releases 2026-01-11 and 2026-09-22, prnewswire.com Kroger–Instacart 2025-11-04, grocerydive.com Cooklist 2026-06.

## Instacart Developer Platform

Covers, in Washington: Costco (and Costco Business Center), Safeway, Albertsons, Haggen, QFC, Fred Meyer, PCC Community Markets, Metropolitan Market, Town & Country Markets.

### What the self-serve tier does

Exactly two capabilities, also exposed as a hosted MCP server (`https://mcp.instacart.com/mcp`, dev `https://mcp.dev.instacart.tools/mcp`):

- `POST /idp/v1/products/products_link` creates a shopping-list page and returns `products_link_url`.
- `POST /idp/v1/products/recipe` creates a shoppable recipe page and returns `products_link_url`.
- `GET /idp/v1/retailers?postal_code=&country_code=US` lists nearby retailers (`retailer_key`, `name`, `retailer_logo_url`). A separate API key must be requested for this endpoint.

Base URLs: dev `https://connect.dev.instacart.tools`, prod `https://connect.instacart.com`. Bearer API key.

Line items: `name` (generic, no brand, weight, or quantity words), `display_text`, `line_item_measurements: [{ quantity, unit }]` from a supported-units list, optional `upcs` (ordered fallbacks) or `product_ids` (mutually exclusive), `filters.brand_filters` (exact catalog spelling), `filters.health_filters` (ORGANIC, GLUTEN_FREE, FAT_FREE, VEGAN, KOSHER, SUGAR_FREE, LOW_FAT), `landing_page_configuration.partner_linkback_url`, `enable_pantry_items` (recipe only), `expires_in` ≤365 days (default 30). The older `quantity`/`unit` fields were deprecated 2026-03-18. Duplicate UPCs return 400.

Flow: the user opens the URL, Instacart shows stores carrying at least 40% of the items, the user picks a store (or we preselect one by appending `?retailer_key=<key>`, per the tutorial; confirm with a dev key), Instacart matches products, the user signs in and checks out on Instacart. Unmatched-item behavior is not documented beyond "Instacart notifies the user and offers alternatives" for unavailable UPCs.

**Not available at this tier:** cart read or write, orders, delivery or pickup windows, prices, any Instacart data. A partner-only MCP tier ("contact your Instacart representative," OAuth) can "discover retailers, search products, and manage carts." Connect fulfillment APIs are for retailers only.

### Business model, approval, limits

No developer fee stated. Optional affiliate commission through Impact.com on conversion events (rates unpublished). A dev key works immediately against the dev server. A production key triggers a review: Instacart requests a demo within five business days; end to end is about 30–40 days. The demo must show the Instacart-branded CTA (their button spec and colors). **The marketing page said "We are currently not accepting new applications" on 2026-10-29 while the docs still linked "Apply today."** Rate limits are not documented.

### Terms that shape the product (developer terms)

- §3.5(k)(iv): no displaying priced items from multiple retailers on one screen.
- §3.5(l): no moving or comparing items between retailer baskets.
- §3.5(r): no alternative checkout. §3.5(e): no scraping. §3.3: no key sharing.
- §7: Instacart data is confidential; delete within five business days on request or termination.
- Copy rules: never say "partner"; never say "Free Delivery"; use marks only to indicate compatibility.
- §14.1: termination at any time at Instacart's discretion.

Costco on Instacart: Costco Same-Day Delivery (sameday.costco.com) is members-only; non-members can shop Costco on instacart.com at higher prices with a $35 minimum.

Sources: docs.instacart.com (developer_platform_api: create_shopping_list_page, create_recipe_page, get_nearby_retailers, tutorials/create_a_recipe_page, tutorials/mcp, changelog, approval_process, pre-launch_checklist, developer_terms; mcp_servers/get-started; connect), company.instacart.com/business/developers, instacart.com city pages for Seattle and Snohomish, customerservice.costco.com answer 8150.

## Costco

No public or partner API found. `doc.api.digital.costco.com` exists in search indexes but redirect-looped during research; its audience is unknown. Costco Same-Day is a members-only Instacart storefront. Costco Business Center is on Instacart in Seattle. Costco's Q2 FY26 call mentioned "working closely with the leading AI companies," but Costco is not a named partner of any agentic-commerce program.

Terms (costco.com terms and conditions of use): §9 prohibits "data mining, robots, agents or similar data gathering or extraction methods" and developing or using "any applications or software that interact with our Services without our prior written consent"; §5 prohibits sharing account credentials. Observed: costco.com returned HTTP 429 to a plain curl and ships Kasada bot protection on Akamai.

## Safeway, Albertsons, Haggen (Albertsons Companies)

No developer API. `developer.albertsons.com` does not resolve. The only APIs are for advertisers (Albertsons Media Collective) and suppliers (Syndigo partner portal).

Merger: blocked. On 2024-12-10 a federal court in Oregon granted the FTC's injunction and King County Superior Court permanently enjoined the merger under Washington law. Albertsons terminated the deal on 2024-12-11 and sued Kroger in Delaware Chancery; trial began 2026-10-19. The companies share nothing.

Channels: Drive Up & Go curbside, own delivery, Instacart (since 2017), DoorDash, Uber Eats. Safeway promotions exclude third-party orders. Albertsons shipped a Safeway plugin inside ChatGPT (2026-08-05) that finds products, builds carts, and sends users to Safeway to check out; its own assistant runs on Google Cloud. Nothing is open to third-party developers.

Terms (terms of use 2025-05-14, covering Safeway, Albertsons, Haggen): §18(a) no access "through any means other than the visual user interfaces authorized by the Company"; §18(c) no data extraction or scraping tools; §18(d) no automated systems; §18(b) no use "for any commercial purpose without the Company's prior written approval." Observed: safeway.com uses Imperva plus Akamai.

## Agentic-commerce protocols: watch, do not build on yet

| Program | State (Oct 2026) | Usable by us? |
|---|---|---|
| OpenAI + Stripe Agentic Commerce Protocol (ACP) | Open source (Apache 2.0), beta. OpenAI ended in-chat Instant Checkout in March 2026; checkout now completes on merchant sites. Instacart had an ACP app in ChatGPT (Dec 2025) | No merchant accepts non-ChatGPT buyer agents |
| Google UCP / AP2 / Universal Cart | Apache 2.0 specs. Universal Cart partners are Nike, Sephora, Target, Ulta, Walmart, Wayfair, Shopify merchants. Kroger is a UCP endorser; "food ordering coming soon." Instacart in Gemini sends the user to Instacart to pay | No grocer live; no non-Google buyer agents |
| Visa Intelligent Commerce | Open to independent developers: sandbox → certification → production, Visa approval per step | Payment rail only; no grocer integration |
| Mastercard Agent Pay | Registered token requestors only | No |
| PayPal Agent Toolkit, Shopify Agentic Storefronts, Perplexity Buy with Pro, Amazon Buy for Me | Merchant-side or closed | No; Shopify excludes local pickup |

Design implication: keep `checkout` behind the adapter contract so an ACP or UCP adapter can slot in later without touching the agent. Re-check quarterly.

## Tier 3: browser automation (feature-flagged, opt-in)

Costco runs Kasada and Safeway runs Imperva. Both block headless browsers from cloud IPs quickly. Both terms forbid non-UI access. Legally, hiQ v. LinkedIn (9th Cir. 2022) kept public scraping outside the CFAA but LinkedIn won on contract; in Amazon v. Perplexity an appeals court vacated the injunction on 2026-08-04, reasoning that users, not Perplexity, accessed Amazon, while contract claims remain live. The practical exposure is the user's account.

| Mode | What | Status |
|---|---|---|
| **A: on-device assisted** | The agent drives an in-app WebView on the user's phone or the desktop app, logged in as the user, with the user watching. Real browser, residential IP, the user's cookies. The agent reads the accessibility tree or DOM through an injected bridge, adds items, selects a slot, and stops at the pay button; the user taps it, or the agent taps it under an opted-in cap. CAPTCHA and MFA appear to the user | Build first (WS10) |
| **B: household-hosted worker** | The same adapter running Playwright on a Mac mini or home server the household owns, with a persistent profile. Enables unattended scheduled runs from a residential IP | Document only in WS10; opt-in later |
| **C: cloud headless** | Playwright on Fly.io with residential proxies | Not allowed. Trips Kasada and Imperva, weakest legal posture |

Common to all modes: no retailer passwords stored (session cookies only, encrypted in Vault, revocable); every step screenshotted into the run transcript; per-household opt-in with consent copy that names the terms risk and the account exposure; PostHog kill switch `tier3_browser_checkout`; spending caps in code; `checkout` never runs without an approved review or an explicit auto-approve cap.

## Compliance checklists (reviewers verify these)

**Kroger adapter and any UI that shows Kroger data**
- [ ] Product name, description, price, and image rendered exactly as returned
- [ ] No Kroger product data persisted beyond `cacheUntil`; no search results stored
- [ ] `product_matches` holds no price or stock
- [ ] `cart_snapshot` cleared 24h after run close
- [ ] No other retailer's prices on the same screen as Kroger prices
- [ ] Banner logos appear only in the add-to-cart UI; none on marketing surfaces
- [ ] Privacy policy and data export exist before any external user

**Instacart adapter and UI**
- [ ] One link per store; no combined price view; no moving items between stores in the UI
- [ ] Instacart-branded CTA per their checklist
- [ ] Copy never says "partner" or "Free Delivery"
- [ ] A delete path for any Instacart-sourced data

**Tier 3**
- [ ] Opt-in with consent copy approved by the human (checkpoint 5)
- [ ] No passwords stored; sessions revocable from settings
- [ ] Mode C code paths do not exist
- [ ] Stops at pay unless `auto_checkout` is enabled under cap
