# 04 · Integrations

Research collected 2026-10-29 from primary sources (developer portals, official docs, terms of service, press releases, court records). Facts that could not be confirmed are in `09-open-questions.md`.

## The hard constraint

No API from Kroger, Albertsons, or Costco, and no agentic-commerce protocol, lets a third party pay or select a pickup or delivery window today. Every official path ends with the user tapping "place order" in the retailer's own app or site. That makes Tier 1 ("fill the cart, the user pays") the path for Kroger banners and Tier 3 (the agent drives the retailer's own site in the app's WebView) the main path for every store without an API, and the only route to hands-off checkout. Tier 2 (Instacart hand-off) was retired on 2026-10-30; see the Instacart section below.

## Feasibility matrix

| Retailer | Product search | Add to cart | Checkout / pay | Pick a slot | Order history |
|---|---|---|---|---|---|
| QFC / Fred Meyer | **Direct API** (Kroger Products) | **Direct API** (Kroger Cart, add-only) | User completes at kroger.com/checkout or in the banner app (Tier 1) · Tier 3 browser | User in app · Tier 3 browser | Not in public tier; we record from our run ledger |
| Safeway / Albertsons / Haggen | Tier 3 browser | Tier 3 browser | Tier 3 browser, stops at pay for the user's tap | Tier 3 browser | Not possible via API; ledger |
| Costco | Tier 3 browser, members only | Tier 3 browser | Tier 3 browser, stops at pay for the user's tap | Tier 3 browser (delivery where costco.com offers it) | Not possible via API; ledger |

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
  id: 'kroger' | 'safeway' | 'costco';
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
  handoffUrl?(conn: ConnectionHandle, run: RunContext): Promise<string>;    // deep link for Tier 1
}
```

The agent and the UI only ever see this contract. Adding a store is a new adapter plus a capabilities row. The UI renders what each store can do ("Cart fills automatically, you pay in the QFC app"). API adapters run in the worker; browser adapters run wherever the browser is (client WebView in Mode A, household-hosted worker in Mode B), so `packages/agent` has no Node-only dependencies. `mock/` ships a `MockRetailer` with fixtures for tests, evals, and replays.

## Per-retailer adapter plan

| Adapter | Tier | Capabilities | Notes |
|---|---|---|---|
| `kroger` | 1 | search api · cartAdd api · cartRead none · slots handoff · checkout handoff · orders none | First and best adapter. OAuth with PKCE and the `banner` parameter during onboarding. Idempotency via the run ledger, not cart reads. Live product lookups every run; nothing cached past response headers. Deep link to kroger.com/checkout or the QFC or Fred Meyer app. Cart calls can only be tested in production |
| `safeway` (browser) | 3 | all browser | Main path. Mode A on-device. Consent shown once at connect |
| `costco` (browser) | 3 | all browser | Main path. Mode A on-device. Consent shown once at connect. Membership required; non-members are not supported at Costco |
| `kroger` browser extension | 3 | slots browser · checkout browser | Optional: finishes slot and pay after the API filled the cart |

**Cross-store splitting** stays inside Kroger's terms because the only prices we display come from the Kroger API (one retailer family), and other stores are assigned by household rules ("bulk and paper goods → Costco," "produce → QFC") and learned preferences, never by comparing prices across retailers on one screen. Browser adapters read prices during a run for the household's own cart; those prices are never shown next to Kroger prices.

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

## Instacart (retired 2026-10-30)

Instacart's Developer Platform was the planned Tier 2 hand-off for Safeway, Albertsons, Haggen, and Costco. On 2026-10-30 the developer page read "We are currently not accepting new applications. There is no waitlist available at this time." Without a production key the hand-off cannot ship, and the self-serve tier never offered cart, slot, price, or order access. Instacart is not a supported retailer. The browser adapters cover those stores instead. The research that backed the old plan is in git history (`docs/04-integrations.md` before this date). Re-check the developer page quarterly; a sanctioned cart-write tier would be worth an adapter again.

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

## Tier 3: browser automation (main path for stores without an API)

Costco runs Kasada and Safeway runs Imperva. Both block headless browsers from cloud IPs quickly. Both terms forbid non-UI access. Legally, hiQ v. LinkedIn (9th Cir. 2022) kept public scraping outside the CFAA but LinkedIn won on contract; in Amazon v. Perplexity an appeals court vacated the injunction on 2026-08-04, reasoning that users, not Perplexity, accessed Amazon, while contract claims remain live. The practical exposure is the user's account.

| Mode | What | Status |
|---|---|---|
| **A: on-device assisted** | The agent drives an in-app WebView on the user's phone or the desktop app, logged in as the user, with the user watching. Real browser, residential IP, the user's cookies. The agent reads the accessibility tree or DOM through an injected bridge, adds items, selects a slot, and stops at the pay button; the user taps it, or the agent taps it under an opted-in cap. CAPTCHA and MFA appear to the user | Build: WS08 ships the host, bridge, sessions, consent, and gating; WS10 ships the Safeway, Costco, and Kroger adapters and the run screen |
| **B: household-hosted worker** | The same adapter running Playwright on a Mac mini or home server the household owns, with a persistent profile. Enables unattended scheduled runs from a residential IP | Document only in WS08; beyond v1 |
| **C: cloud headless** | Playwright on Fly.io with residential proxies | Not allowed. Trips Kasada and Imperva, weakest legal posture |

Common to all modes: no retailer passwords stored (session cookies and storage state only, encrypted on the device with a key held in Vault, revocable); every step screenshotted into the run transcript; consent copy shown once when the household connects a Tier 3 store, naming the terms risk and the account exposure, recorded in `households.tier3_consent`; PostHog flag `tier3_browser_checkout` on by default and used as a kill switch, per retailer; spending caps in code; `checkout` never runs without an approved review or an explicit auto-approve cap.

## Compliance checklists (reviewers verify these)

**Kroger adapter and any UI that shows Kroger data**
- [ ] Product name, description, price, and image rendered exactly as returned
- [ ] No Kroger product data persisted beyond `cacheUntil`; no search results stored
- [ ] `product_matches` holds no price or stock
- [ ] `cart_snapshot` cleared 24h after run close
- [ ] No other retailer's prices on the same screen as Kroger prices
- [ ] Banner logos appear only in the add-to-cart UI; none on marketing surfaces
- [ ] Privacy policy and data export exist before any external user

**Tier 3**
- [ ] Consent copy approved by the human (checkpoint 4) and shown before the first connect to each Tier 3 store; `tier3_consent` records the retailers and copy version
- [ ] No Tier 3 store's prices appear on the same screen as Kroger prices
- [ ] No passwords stored; sessions revocable from settings
- [ ] Mode C code paths do not exist
- [ ] Stops at pay unless `auto_checkout` is enabled under cap
