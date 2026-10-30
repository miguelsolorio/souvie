# WS10: Browser adapters (Safeway, Costco; optional Kroger slot + pay)

**Wave:** 6 · **Suggested model:** Opus · **Branch:** `ws/10-browser-adapters`

## Goal
When this is done, a household that has explicitly opted in can let the agent drive the Safeway or Costco website inside the app, logged in as the user, on the user's own phone or desktop, to search products, add them to the cart, pick a pickup or delivery window, and stop at the pay button for a final tap. This is Tier 3, the only route to hands-off checkout because no retailer or protocol exposes payment or slot selection to third parties today. It is feature-flagged, off by default, carries consent copy that names the terms-of-service and account risks, stores no passwords, and screenshots every step into the run transcript. The same adapter shape also lets Kroger households finish slot selection and payment after the API filled the cart.

## Depends on
- WS09 (Shopping agent + worker + review UI): `packages/agent` loop that is host-agnostic, tool plumbing for `get_slots`, `select_slot`, `checkout`, the run state machine, `shopping_runs`, `shopping_run_items`, the review UI, and `RunPolicy.autoCheckout`.
- WS07 (Retailer framework): `RetailerAdapter`, typed errors, `retailer_connections` with `auth_type = 'browser_session'`, Vault helpers.
- WS01 (Auth & households): household membership for opt-in scope.
- Human checkpoint 5: the orchestrator has the human's approval of the consent copy in `apps/mobile/features/tier3/consent.ts` and the list of retailers that get adapters. Do not start without it.

## Read first
1. `docs/04-integrations.md` §5.2 Costco and Safeway blocks (bot protection, terms clauses), §5.5 (Tier 3 modes A, B, C and the common rules).
2. `docs/05-security-privacy.md` on session storage, Vault, audit, spending controls.
3. `docs/06-risks.md` rows R16, R17, R19, R20, R22.
4. `docs/03-ai-design.md` §4.8 (agent tools and policies).
5. `packages/agent/src/tools.ts` and `packages/retailers/src/types.ts` as merged.

## In scope
- **Mode A, on-device assisted (build this):** a `BrowserHost` abstraction in `packages/retailers/src/browser/host.ts` with one implementation backed by `react-native-webview` in `apps/mobile/features/tier3/WebViewHost.tsx`. The host exposes `navigate`, `snapshot()` (serialized accessibility-style DOM tree with stable element ids, text, roles, and bounding boxes), `click(id)`, `type(id, text)`, `select(id, value)`, `waitFor(predicate, timeoutMs)`, `screenshot()`, and `url()`. Communication is an injected JS bridge over `postMessage`.
- `SafewayBrowserAdapter` and `CostcoBrowserAdapter` in `packages/retailers/src/browser/safeway/` and `browser/costco/`, implementing `RetailerAdapter` with capabilities `{ search: 'browser', cartAdd: 'browser', cartRead: 'browser', slots: 'browser', checkout: 'browser', orders: 'none' }`. Each adapter is a set of page "skills" (search, product tile parsing, add to cart, cart read, slot picker, checkout progression to the pay step) written against the snapshot tree, with text and role heuristics rather than brittle CSS selectors, plus a per-site `recipes.ts` of known flows.
- `KrogerBrowserAdapter` in `browser/kroger/` with capabilities `{ search: 'none', cartAdd: 'none', cartRead: 'browser', slots: 'browser', checkout: 'browser', orders: 'none' }` that resumes at kroger.com/checkout after the API filled the cart.
- An on-device run host: `apps/mobile/features/tier3/AssistedRunScreen.tsx` that shows the WebView at full size with a thin status bar above it ("Adding item 4 of 12"), runs `packages/agent` in the app's JS thread with the WebView-backed adapter, and pauses on CAPTCHA, MFA, unexpected navigation, or the pay step so the user acts directly in the WebView.
- Session handling: the user logs in inside the WebView the first time; the adapter persists only session cookies and storage state, encrypted with a per-connection key held in Supabase Vault, in the device's secure storage (`expo-secure-store`), never on our servers in plaintext and never as passwords. A "Disconnect" action wipes the WebView's cookie store and the secure-store entry and sets `retailer_connections.status = 'revoked'`.
- Consent and opt-in: `apps/mobile/features/tier3/ConsentScreen.tsx` with the approved copy; `households.tier3_consent` jsonb `{ acceptedAt, acceptedBy, retailers: string[], version }`; PostHog flag `tier3_browser_checkout` must be on AND consent recorded before any browser adapter is constructible. `getAdapter('safeway')` throws `RetailerNotSupportedError` otherwise.
- Pay-step gate: the adapter's `checkout()` navigates to the final review page and returns `{ orderRef: 'AWAITING_USER' }`, surfacing the pay button to the user. Only when `RunPolicy.autoCheckout === true` and the on-screen total is at or below `budgetCapUsd` does the adapter tap the pay button itself, then waits for a confirmation page and extracts the order number.
- Screenshots: every tool call in a browser run appends a screenshot to Supabase Storage bucket `run-screenshots/<runId>/<step>.jpg` (quality 60) and a transcript entry references it. Retention 30 days via a Storage lifecycle rule.
- Kill switch: the agent checks the PostHog flag before every browser tool call; a flipped flag aborts the run with `cancelled` and a notice.
- **Mode B, household-hosted worker (document only):** `services/shopper-worker/README.md` gains a section describing a Playwright-backed `BrowserHost` on a Mac mini or home server with a persistent profile, how it would plug into the same adapters, and why it is not built now.
- Tests: adapter skills against saved DOM snapshots of real pages (captured manually with the dev tool below, scrubbed of personal data), host bridge tests with a mocked WebView, consent gating tests, pay-gate tests.
- A dev-only snapshot capture tool at `apps/mobile/app/(dev)/snapshot.tsx` to save a scrubbed snapshot tree from the WebView for fixtures.

### Pause conditions (the run stops and the user acts in the WebView)

| Reason | Detection | Resume rule |
|---|---|---|
| `login` | URL matches the site's sign-in path or a password field is present | User signs in; adapter re-checks the account menu, then continues |
| `captcha` | An iframe or node whose name matches `/captcha\|verify you are human\|press and hold/i` | User clears it; adapter waits for the node to disappear |
| `mfa` | A one-time-code field appears | User enters the code; adapter continues |
| `pay` | Final review page detected and `autoCheckout` is false, or total exceeds `budgetCapUsd` | User taps pay or cancels; adapter reads the confirmation page if it appears |
| `unexpected` | A recipe step cannot find its target within `waitFor` timeout, or the URL leaves the site | Screenshot plus transcript entry; user can retry the step or cancel |
| `membership` | Costco shows the members-only wall | `MembershipRequiredError`; the app offers the WS08 Instacart route |

Every pause writes a transcript entry with the reason and a screenshot, and shows a one-line banner above the WebView. There is no timeout on a pause; the run waits for the user or for cancel.

### Skills per site

| Skill | Safeway | Costco | Kroger (resume only) |
|---|---|---|---|
| Set store / fulfillment | Store locator by ZIP, choose Drive Up & Go or delivery | Warehouse selector; Same-Day delivery is Instacart-powered and out of scope | Not needed; set by API modality |
| Search | Search box, results grid, "Add" buttons, size and unit price text | Search box, product tiles, "Add" buttons, membership gating | Not needed |
| Parse product tile | name, price, promo badge, size, add-button id | name, price, item number, size, add-button id | Not needed |
| Add to cart / quantity | Add then stepper | Add then stepper | Not needed |
| Read cart | Cart page rows: name, qty, price | Cart page rows | Checkout page rows |
| Slots | Pickup or delivery time grid with fees | Delivery windows (where offered) | Pickup time grid |
| Checkout to pay step | Proceed through address and payment review to the place-order page, stop | Same | Same |
| Confirmation parse | Order number node after pay | Order number node | Order number node |

Recipes are data (`recipes.ts`): ordered steps with target heuristics and expected post-conditions, so a site change is a fixture update, not a rewrite.

## Out of scope
- Mode C, cloud headless browsers. Forbidden. No Playwright or Puppeteer in `services/shopper-worker` in this WS. The only Playwright mention is in the Mode B README section.
- Residential proxies, fingerprint spoofing, CAPTCHA solving, or any bot-detection evasion. If the site blocks, the run pauses and the user acts.
- Storing retailer passwords anywhere, or autofilling them.
- Instacart.com automation. Instacart has a sanctioned hand-off (WS08).
- Changing the agent loop or `RetailerAdapter` contract. File contract change requests.
- Order history scraping (WS12 decides; Tier 3 writes an `orders` row only from the confirmation page of a run it completed).

## Deliverables

- `supabase/functions/llm-proxy/index.ts`: Edge Function that forwards the on-device agent's model calls to Anthropic with the server-side key, enforces the household cost cap through `packages/llm`, and writes `ai_runs`. This WS owns it; no other WS creates it.
- `packages/retailers/src/browser/host.ts` (interface), `snapshot.ts` (tree types and serializer contract), `skills.ts` (shared heuristics: find by role and text, nearest button, price parsing, quantity stepper).
- `packages/retailers/src/browser/safeway/SafewayBrowserAdapter.ts`, `recipes.ts`, `__fixtures__/*.snapshot.json`, `*.test.ts`.
- `packages/retailers/src/browser/costco/CostcoBrowserAdapter.ts`, `recipes.ts`, `__fixtures__/*.snapshot.json`, `*.test.ts`.
- `packages/retailers/src/browser/kroger/KrogerBrowserAdapter.ts`, `recipes.ts`, `__fixtures__/*.snapshot.json`, `*.test.ts`.
- `packages/retailers/src/browser/gating.ts` (flag + consent checks) and `gating.test.ts`.
- `apps/mobile/features/tier3/WebViewHost.tsx`, `bridge.js` (injected script), `AssistedRunScreen.tsx`, `ConsentScreen.tsx`, `consent.ts` (approved copy, versioned), `useTier3Session.ts`, `secureSession.ts`.
- `apps/mobile/app/(dev)/snapshot.tsx`.
- `supabase/migrations/<timestamp>_ws10_tier3.sql`: `households.tier3_consent jsonb`, `retailer_connections.auth_type` includes `'browser_session'`, Storage bucket `run-screenshots` with RLS, lifecycle 30 days.
- `supabase/tests/ws10_tier3_rls.sql`.
- `services/shopper-worker/README.md` Mode B section.
- Docs update: `docs/04-integrations.md` §5.5 "Implemented" notes per retailer and the exact pause conditions.

## Interfaces
**Implements**
- `BrowserHost`:
  ```ts
  interface BrowserHost {
    navigate(url: string): Promise<void>;
    url(): Promise<string>;
    snapshot(opts?: { maxNodes?: number }): Promise<SnapshotTree>;
    click(nodeId: string): Promise<void>;
    type(nodeId: string, text: string, opts?: { clear?: boolean }): Promise<void>;
    select(nodeId: string, value: string): Promise<void>;
    waitFor(check: (tree: SnapshotTree, url: string) => boolean, timeoutMs: number): Promise<void>;
    screenshot(): Promise<Uint8Array>;
    onUserRequired(cb: (reason: 'captcha' | 'mfa' | 'login' | 'pay' | 'unexpected') => void): void;
  }
  interface SnapshotNode { id: string; role: string; name: string; text?: string; value?: string; href?: string; bbox: [number, number, number, number]; children?: SnapshotNode[]; }
  type SnapshotTree = { url: string; title: string; root: SnapshotNode; capturedAt: string };
  ```
- Browser adapters conform to `RetailerAdapter` (WS07) with the capability rows above. `checkout(conn, policy)` returns `{ orderRef: 'AWAITING_USER' }` or a real order number.
- `tier3Gate(householdId, retailer): Promise<void>` throws unless flag on and consent recorded for that retailer.
- Table changes listed under Deliverables.

**Consumes**
- `packages/agent` loop and tools (WS09); it must run in the app's JS runtime, so keep the agent's Anthropic calls going through the `packages/llm` client configured for the app (API key never in the app bundle: calls proxy through the `llm-proxy` Edge Function WS00 or WS09 created; if none exists, add `supabase/functions/llm-proxy/` here and note it as a deviation).
- `retailer_connections`, `shopping_runs`, `shopping_run_items`, `households.tier3_consent`, `RunPolicy`.
- PostHog flag `tier3_browser_checkout`; Supabase Storage; `expo-secure-store`; `react-native-webview`.

**Facts the implementation must respect**
- Costco: Kasada bot protection on Akamai; plain curl got HTTP 429. Terms bar "applications or software that interact with our Services without our prior written consent" and bar sharing account credentials; the member is responsible for the account. Costco Same-Day on Instacart is members-only.
- Safeway/Albertsons: Imperva plus Akamai. Terms §18 bar access "through any means other than the visual user interfaces," any automated system, and commercial use without approval.
- Kroger sites run behind Akamai; the API filled the cart legitimately, and the browser adapter only resumes at checkout for slot and pay.
- Amazon v. Perplexity (appeals court, Aug 2026) vacated an injunction on the reasoning that the user, not the agent vendor, accessed the site; contract claims survive. The user is the one acting; the app assists. Keep the user's device, cookies, and residential IP in the loop, and never run unattended in the cloud.

## Acceptance criteria
1. `pnpm typecheck && pnpm lint` pass. `grep -rn "playwright\|puppeteer" packages services apps --include=*.ts --include=*.tsx --include=package.json` returns only the README mention.
2. `gating.test.ts`: with the flag off, `getAdapter('safeway')` throws `RetailerNotSupportedError`; with the flag on and no consent, it throws; with both, it constructs. Flipping the flag mid-run cancels at the next tool call.
3. `SafewayBrowserAdapter` tests against snapshot fixtures: search page parses at least 8 product tiles with name, price, size, and an add button id; add-to-cart recipe clicks the right button for a given tile; cart page parses quantities; slot picker lists windows with start, end, and fee; checkout recipe stops on the review page and reports `AWAITING_USER`.
4. `CostcoBrowserAdapter` tests cover the same skills on Costco snapshots, including the warehouse/delivery selector and the membership-required state, which must raise a typed `MembershipRequiredError`.
5. `KrogerBrowserAdapter` tests: cart read parses items and quantities from a checkout snapshot; slot and pay recipes stop at `AWAITING_USER`.
6. Pay gate test: `autoCheckout: false` never clicks a node whose name matches `/place order|pay now|submit order|buy now/i`; `autoCheckout: true` with on-screen total $150 and `budgetCapUsd: 120` does not click; with cap 200 it clicks once and waits for a confirmation node.
7. Bridge test with a mocked WebView: `snapshot()` returns stable ids across two calls on an unchanged DOM; `click` and `type` post the expected messages; `onUserRequired('captcha')` fires when a node with role `iframe` and name matching `/captcha|verify you are human/i` appears.
8. Session test: after login in the WebView, `secureSession.ts` stores an encrypted blob in `expo-secure-store` keyed by connection id; no string in the blob matches the test password; disconnect removes the entry and clears WebView cookies.
9. Screenshot test: a run with 7 tool calls produces 7 objects under `run-screenshots/<runId>/`; RLS test `ws10_tier3_rls.sql` confirms another household cannot list or read them.
10. Consent test: the consent screen cannot be dismissed without scrolling to the end and checking the acknowledgment; `households.tier3_consent.version` matches `consent.ts` `CONSENT_VERSION`.
11. Manual end to end on the iOS Simulator with the developer's own Safeway account: opt in → run a 6-item list → watch the WebView add items → pick a pickup window → the run pauses at the pay step → the developer taps pay (or cancels) → transcript shows 1 screenshot per step. Record a screen recording path and whether any bot challenge appeared.
12. Manual end to end with the developer's Costco account (member): the same flow through to the review page; if Costco shows a challenge, the run pauses with reason `captcha` and resumes after the user clears it.
13. Manual Kroger resume: after a WS09 Kroger run reaches `cart_ready`, "Finish in app" opens the Kroger browser adapter at checkout, lists slots, selects the preferred one, and stops at pay.
14. `supabase test db` passes `ws10_tier3_rls.sql`.

## Verification commands
```bash
pnpm typecheck && pnpm lint                                   # expected: exit 0
grep -rn "playwright\|puppeteer" packages services apps --include=*.ts --include=*.tsx --include=package.json   # expected: README only
pnpm test --filter retailers -- browser                       # expected: safeway, costco, kroger, gating, skills tests green
pnpm test --filter mobile -- tier3                            # expected: bridge, session, consent, pay-gate tests green
supabase start && supabase db reset && supabase test db       # expected: ws10 migration applies; bucket created; RLS passes
pnpm --filter mobile start                                    # manual: ConsentScreen → AssistedRunScreen flows for Safeway, Costco, Kroger resume
```

## Risks and notes
- R16: bot detection. Mode A runs in a real WebView on the user's device with the user's cookies and IP, which is the lowest-risk posture available. Still expect challenges; the design pauses and lets the human clear them. Never add evasion.
- R17: terms. Costco and Albertsons both prohibit this in their terms; the exposure is the user's account. Consent copy must say so plainly, name each retailer, and be versioned. Default off. Per-retailer kill switch.
- R19: this is the only route to hands-off checkout and the product should say "with your final tap" unless `autoCheckout` is on.
- R20: Costco membership. Non-members get `MembershipRequiredError` and the WS08 Instacart route.
- R22: commercial use. Albertsons' terms bar commercial use without approval; keep Tier 3 personal-use-only until the business posture changes.
- Fragility: sites change. Skills use role and text heuristics, snapshots are versioned fixtures, and a failing recipe pauses the run with reason `unexpected` and a screenshot instead of guessing.
- Legal posture: user-driven, on-device, no stored passwords, no cloud automation, no evasion. Document it in `docs/04-integrations.md` so future contributors do not drift into Mode C.
- Battery and foreground: the WebView must stay in the foreground; use `expo-keep-awake` during an assisted run and pause cleanly on background.
- Desktop: the same `BrowserHost` can be implemented for the Tauri build with a webview window in WS13 later; keep `host.ts` platform-neutral.

## Completion report
End with the report format from `docs/implementation-guide.md` §6.2 (Message templates) (Built, Files changed, Verification output, Deviations from brief, Contract change requests, Open issues, Follow-ups). Nothing else is read by the orchestrator.
