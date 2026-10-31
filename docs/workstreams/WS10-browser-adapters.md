# WS10: Browser adapters (Safeway, Costco; Kroger slot + pay)

**Wave:** 6 · **Suggested model:** Opus · **Branch:** `ws/10-browser-adapters`

## Goal
When this is done, a household that connected Safeway, Albertsons, Haggen or Costco can let the agent drive the retailer's own website inside the app, logged in as the user, on the user's own phone, to search products, add them to the cart, pick a pickup or delivery window, and stop at the pay button for a final tap. Tier 3 is the main path for these retailers because no retailer or protocol exposes payment or slot selection to third parties and Instacart's Developer Platform is closed to new applicants. Consent was given once at connect (WS08). The PostHog flag `tier3_browser_checkout` defaults on and is a kill switch, checked before every browser tool call. No passwords are stored. Every step is screenshotted into the run transcript. The same adapter shape also lets Kroger households finish slot selection and payment after the API filled the cart.

## Depends on
- WS08 (Assisted checkout host): `BrowserHost`, `SnapshotTree`, `skills.ts`, the WebView host and bridge, `secureSession.ts` and `useTier3Session.ts`, `ConsentScreen` and `consent.ts`, `tier3Gate`, the `llm-proxy` Edge Function, `households.tier3_consent`, the `run-screenshots` bucket, and the dev snapshot capture tool used to record fixtures.
- WS09 (Shopping agent + worker + review UI): `packages/agent` loop that is host-agnostic, tool plumbing for `get_slots`, `select_slot`, `checkout`, the run state machine, `shopping_runs`, `shopping_run_items`, the review UI, and `RunPolicy.autoCheckout`.
- WS07 (Retailer framework): `RetailerAdapter`, capabilities, typed errors, `retailer_connections` with `auth_type = 'browser_session'`, Vault helpers.
- Human checkpoint 5: the WS08 host demo is accepted and the retailer list is confirmed. Adapters may start only after that.

## Read first
1. `docs/04-integrations.md` Costco and Safeway, Albertsons, Haggen blocks (bot protection, terms clauses), then "Tier 3: browser automation" (modes A, B, C and the common rules).
2. `docs/05-security-privacy.md` "Retailer credentials and sessions", "Money", "Audit".
3. `docs/06-risks.md` rows R16, R17, R19, R20, R22.
4. `docs/03-ai-design.md` §8 Shopping agent (Tools, Policies, Run state machine).
5. `packages/retailers/src/browser/host.ts`, `snapshot.ts`, `skills.ts`, `gating.ts` (WS08); `packages/agent/src/tools.ts` (WS09); `packages/retailers/src/types.ts` (WS07) as merged.

## In scope
- `SafewayBrowserAdapter` and `CostcoBrowserAdapter` in `packages/retailers/src/browser/safeway/` and `browser/costco/`, implementing `RetailerAdapter` with capabilities `{ search: 'browser', cartAdd: 'browser', cartRead: 'browser', slots: 'browser', checkout: 'browser', orders: 'none' }`. The Safeway adapter serves the Safeway, Albertsons and Haggen banners (one Albertsons Companies platform) under the single registry id `safeway`; the banner is read from the connection, stored as `retailer_connections.store_id = '<banner>:<storeNumber>'` with banner in `safeway | albertsons | haggen`, chosen in the connect flow. `RetailerId` and `enum retailer` stay `kroger | safeway | costco`. Each adapter is a set of page skills (search, product tile parsing, add to cart, cart read, slot picker, checkout progression to the pay step) written against the snapshot tree with WS08's text and role heuristics rather than CSS selectors, plus a per-site `recipes.ts` of known flows.
- `KrogerBrowserAdapter` in `browser/kroger/` with capabilities `{ search: 'none', cartAdd: 'none', cartRead: 'browser', slots: 'browser', checkout: 'browser', orders: 'none' }` that resumes at kroger.com/checkout after the API filled the cart.
- `apps/mobile/features/tier3/AssistedRunScreen.tsx`: shows the WebView host at full size with a thin status bar above it ("Adding item 4 of 12"), runs `packages/agent` in the app's JS thread with the WebView-backed adapter and the `llm-proxy` client, and pauses on the conditions below so the user acts directly in the WebView.
- Pay-step gate: the adapter's `checkout()` navigates to the final review page and returns `{ orderRef: 'AWAITING_USER' }`, surfacing the pay button to the user. Only when `RunPolicy.autoCheckout === true` and the on-screen total is at or below `budgetCapUsd` does the adapter tap the pay button itself, then waits for a confirmation page and extracts the order number.
- Screenshots: every tool call in a browser run uploads `host.screenshot()` to `run-screenshots/<runId>/<step>.jpg` (quality 60) and the transcript entry references it. The bucket and its 30-day lifecycle are WS08's.
- Kill switch: the agent checks PostHog flag `tier3_browser_checkout` before every browser tool call; a flipped flag aborts the run with `cancelled` and a notice.
- Membership: onboarding captured `profiles.costco_member`. The Costco adapter raises `MembershipRequiredError` on the members-only wall; the app explains that Costco needs a membership and offers to continue with the household's other stores.
- Tests: adapter skills against saved DOM snapshots of real pages (captured with WS08's dev tool, scrubbed of personal data), pay-gate tests, kill-switch tests, pause-condition tests.
- Docs update: `docs/04-integrations.md` Tier 3 section gains "Implemented" notes per retailer and the exact pause conditions.

### Pause conditions (the run stops and the user acts in the WebView)

| Reason | Detection | Resume rule |
|---|---|---|
| `login` | Bridge `userRequired: login` (sign-in URL or password field) | User signs in; adapter re-checks the account menu, then continues |
| `captcha` | Bridge `userRequired: captcha` (`/captcha\|verify you are human\|press and hold/i`) | User clears it; adapter waits for the node to disappear |
| `mfa` | Bridge `userRequired: mfa` (one-time-code field) | User enters the code; adapter continues |
| `pay` | Final review page detected and `autoCheckout` is false, or total exceeds `budgetCapUsd` | User taps pay or cancels; adapter reads the confirmation page if it appears |
| `unexpected` | A recipe step cannot find its target within `waitFor` timeout, or the URL leaves the site | Screenshot plus transcript entry; user can retry the step or cancel |
| `membership` | Costco shows the members-only wall | `MembershipRequiredError`; the app explains Costco needs a membership (onboarding captured `profiles.costco_member`) |

Every pause writes a transcript entry with the reason and a screenshot, and shows a one-line banner above the WebView. There is no timeout on a pause; the run waits for the user or for cancel.

### Skills per site

| Skill | Safeway (Albertsons, Haggen) | Costco | Kroger (resume only) |
|---|---|---|---|
| Set store / fulfillment | Store locator by ZIP, choose Drive Up & Go or delivery | Warehouse selector; delivery where offered | Not needed; set by API modality |
| Search | Search box, results grid, "Add" buttons, size and unit price text | Search box, product tiles, "Add" buttons, membership gating | Not needed |
| Parse product tile | name, price, promo badge, size, add-button id | name, price, item number, size, add-button id | Not needed |
| Add to cart / quantity | Add then stepper | Add then stepper | Not needed |
| Read cart | Cart page rows: name, qty, price | Cart page rows | Checkout page rows |
| Slots | Pickup or delivery time grid with fees | Delivery windows (where offered) | Pickup time grid |
| Checkout to pay step | Proceed through address and payment review to the place-order page, stop | Same | Same |
| Confirmation parse | Order number node after pay | Order number node | Order number node |

Recipes are data (`recipes.ts`): ordered steps with target heuristics and expected post-conditions, so a site change is a fixture update, not a rewrite.

## Out of scope
- The `BrowserHost` interface, bridge, WebView host, snapshot serializer, shared skills, session storage, consent screen and copy, `tier3Gate`, `llm-proxy`, the consent column, the `run-screenshots` bucket, and the dev snapshot tool (WS08). Consume them; file a change request if they fall short.
- Mode C, cloud headless browsers. Forbidden. No Playwright or Puppeteer anywhere; the only mention is WS08's Mode B README section.
- Residential proxies, fingerprint spoofing, CAPTCHA solving, or any bot-detection evasion. If the site blocks, the run pauses and the user acts.
- Storing retailer passwords anywhere, or autofilling them.
- No instacart.com automation. Instacart is not a supported retailer.
- Changing the agent loop or `RetailerAdapter` contract. File contract change requests.
- Order history scraping (WS12 decides; Tier 3 writes an `orders` row only from the confirmation page of a run it completed).

## Deliverables
- `packages/retailers/src/browser/safeway/SafewayBrowserAdapter.ts`, `recipes.ts`, `__fixtures__/*.snapshot.json`, `*.test.ts`.
- `packages/retailers/src/browser/costco/CostcoBrowserAdapter.ts`, `recipes.ts`, `__fixtures__/*.snapshot.json`, `*.test.ts`.
- `packages/retailers/src/browser/kroger/KrogerBrowserAdapter.ts`, `recipes.ts`, `__fixtures__/*.snapshot.json`, `*.test.ts`.
- `packages/retailers/src/browser/payGate.ts` and `payGate.test.ts` (shared across the three adapters).
- `packages/retailers/src/browser/errors.ts` addition: `MembershipRequiredError` (or in WS07's `errors.ts` if the orchestrator prefers; ask in the report).
- Registry entries for `safeway` (all three banners), `costco` and the Kroger resume adapter, each constructed behind `tier3Gate`.
- `apps/mobile/features/tier3/AssistedRunScreen.tsx`, `PauseBanner.tsx`, `useAssistedRun.ts`, `screenshots.ts` (upload per tool call), `killSwitch.ts`.
- `apps/mobile/features/tier3/__tests__/AssistedRunScreen.test.tsx`, `killSwitch.test.ts`, `screenshots.test.ts`.
- "Finish in app" action on WS09's `RunDetail` for Kroger runs at `cart_ready`, mounted through the `actions` prop.
- Migration: none. The consent column and the `run-screenshots` bucket are WS08's. Add `supabase/migrations/<timestamp>_ws10_*.sql` only if a real need appears, and name it as a deviation in the report.
- Docs update: `docs/04-integrations.md` Tier 3 section "Implemented" notes per retailer and the exact pause conditions.

## Interfaces
**Implements**
- Browser adapters conform to `RetailerAdapter` (WS07) with the capability rows above. `checkout(conn, policy)` returns `{ orderRef: 'AWAITING_USER' }` or a real order number.
- `MembershipRequiredError extends RetailerError` with `retailer: 'costco'`.
- `payGate(tree, policy): 'await_user' | 'click'` pure function: returns `click` only when `policy.autoCheckout === true` and the parsed on-screen total is at or below `policy.budgetCapUsd`.
- `Recipe` type: `{ name: string; steps: { find: NodeMatcher; action: 'click' | 'type' | 'select' | 'navigate' | 'wait'; value?: string; expect: (tree: SnapshotTree, url: string) => boolean; timeoutMs: number }[] }`.
- `PauseReason = 'login' | 'captcha' | 'mfa' | 'unexpected' | 'pay' | 'membership'`: the four host reasons from WS08's `onUserRequired` plus the two this WS raises from recipes.
- Transcript entry shape for browser steps: `{ step, tool, screenshotPath: 'run-screenshots/<runId>/<step>.jpg', url, pausedFor?: PauseReason }`.

**Consumes**
- `BrowserHost`, `SnapshotTree`, `skills.ts` (`findByRole`, `findByText`, `nearestButton`, `parsePrice`, `findStepper`), `tier3Gate`, `WebViewHost`, `useTier3Session`, `secureSession` (WS08).
- `llm-proxy` Edge Function for every model call made in the app (WS08); the Anthropic key is never in the bundle.
- `packages/agent` loop and tools (WS09); `RunPolicy`; `shopping_runs`, `shopping_run_items`; `RunDetail.actions`.
- `retailer_connections`, `households.tier3_consent`, `profiles.costco_member`.
- PostHog flag `tier3_browser_checkout`; Supabase Storage bucket `run-screenshots`.

**Facts the implementation must respect**
- Costco: Kasada bot protection on Akamai; plain curl got HTTP 429. Terms bar "applications or software that interact with our Services without our prior written consent" and bar sharing account credentials; the member is responsible for the account.
- Safeway/Albertsons: Imperva plus Akamai. Terms §18 bar access "through any means other than the visual user interfaces," any automated system, and commercial use without approval.
- Kroger sites run behind Akamai; the API filled the cart legitimately, and the browser adapter only resumes at checkout for slot and pay.
- Amazon v. Perplexity (appeals court, Aug 2026) vacated an injunction on the reasoning that the user, not the agent vendor, accessed the site; contract claims survive. The user is the one acting; the app assists. Keep the user's device, cookies, and residential IP in the loop, and never run unattended in the cloud.

## Acceptance criteria
1. `pnpm typecheck && pnpm lint` pass. `grep -rn "playwright\|puppeteer" packages services apps supabase --include=*.ts --include=*.tsx --include=*.js --include=package.json` returns only the WS08 README mention.
2. Registry test: `getAdapter('safeway')` and `getAdapter('costco')` each call `tier3Gate` first; with the gate throwing they throw `RetailerNotSupportedError`; with it resolving they construct. A `safeway` connection whose `store_id` starts with `albertsons:` or `haggen:` yields the Safeway adapter configured for that banner. `killSwitch.test.ts`: flipping the flag mid-run cancels at the next browser tool call with status `cancelled` and a transcript notice.
3. `SafewayBrowserAdapter` tests against snapshot fixtures: search page parses at least 8 product tiles with name, price, size, and an add button id; add-to-cart recipe clicks the right button for a given tile; cart page parses quantities; slot picker lists windows with start, end, and fee; checkout recipe stops on the review page and reports `AWAITING_USER`. The same tests pass with the `albertsons` and `haggen` banners against their fixtures.
4. `CostcoBrowserAdapter` tests cover the same skills on Costco snapshots, including the warehouse selector, delivery windows where offered, and the membership-required state, which must raise `MembershipRequiredError`.
5. `KrogerBrowserAdapter` tests: cart read parses items and quantities from a checkout snapshot; slot and pay recipes stop at `AWAITING_USER`.
6. `payGate.test.ts`: `autoCheckout: false` never clicks a node whose name matches `/place order|pay now|submit order|buy now/i`; `autoCheckout: true` with on-screen total $150 and `budgetCapUsd: 120` does not click; with cap 200 it clicks once and waits for a confirmation node.
7. Pause tests: each row of the pause table is reproduced with a fixture or a mocked bridge event; each pause writes a transcript entry with the reason and a screenshot path and renders `PauseBanner`; `membership` shows the Costco membership explanation and no retry.
8. `screenshots.test.ts`: a run with 7 tool calls produces 7 objects under `run-screenshots/<runId>/` named `001.jpg` to `007.jpg`, each referenced by a transcript entry.
9. Manual end to end on the iOS Simulator with the developer's own Safeway account: connect (consent already recorded by WS08) → run a 6-item list → watch the WebView add items → pick a pickup window → the run pauses at the pay step → the developer taps pay (or cancels) → transcript shows 1 screenshot per step. Record a screen recording path and whether any bot challenge appeared.
10. Manual end to end with the developer's Costco account (member): the same flow through to the review page; if Costco shows a challenge, the run pauses with reason `captcha` and resumes after the user clears it. With `profiles.costco_member = false` on a test profile, the members-only wall produces the `membership` pause.
11. Manual Kroger resume: after a WS09 Kroger run reaches `cart_ready`, "Finish in app" opens the Kroger browser adapter at checkout, lists slots, selects the preferred one, and stops at pay.
12. `docs/04-integrations.md` Tier 3 section lists each implemented retailer with the pause conditions as built.

## Verification commands
```bash
pnpm typecheck && pnpm lint                                   # expected: exit 0
grep -rn "playwright\|puppeteer" packages services apps supabase --include=*.ts --include=*.tsx --include=*.js --include=package.json   # expected: WS08 README only
pnpm test --filter retailers -- browser                       # expected: safeway, costco, kroger, payGate, registry tests green (WS08's host tests stay green)
pnpm test --filter mobile -- tier3                            # expected: AssistedRunScreen, killSwitch, screenshots tests green
supabase start && supabase db reset && supabase test db       # expected: no new WS10 migration; WS08 and WS09 tests still pass
pnpm --filter mobile start                                    # manual: AssistedRunScreen flows for Safeway, Costco, Kroger resume
```

## Risks and notes
- From the WS16 review (2026-10-30): when a list item carries a qualifier ("gluten-free", "dairy-free"), the search query typed into the retailer's site and the product the agent picks must honor it; a match that drops the qualifier is a wrong product, not a near miss. Same rule as the Kroger adapter. (Moved here from the retired Instacart brief; product matching is adapter work, not the WS08 host.)
- R16: bot detection. Mode A runs in a real WebView on the user's device with the user's cookies and IP, which is the lowest-risk posture available. Still expect challenges; the design pauses and lets the human clear them. Never add evasion.
- R17: terms. Costco and Albertsons both prohibit this in their terms; the exposure is the user's account. Consent was recorded once at connect (WS08) and names each retailer; this WS must refuse to construct an adapter without it. The flag is a kill switch, default on. Keep per-retailer kill switch behavior: a flag payload may list disabled retailers.
- R19: this is the only route to hands-off checkout and the product should say "with your final tap" unless `autoCheckout` is on.
- R20: Costco membership. Non-members hit the members-only wall; the app explains that Costco needs a membership and continues with the household's other stores. No alternate retailer route exists.
- R22: commercial use. Albertsons' terms bar commercial use without approval; keep Tier 3 personal-use-only until the business posture changes.
- Fragility: sites change. Skills use role and text heuristics, snapshots are versioned fixtures, and a failing recipe pauses the run with reason `unexpected` and a screenshot instead of guessing.
- Legal posture: user-driven, on-device, no stored passwords, no cloud automation, no evasion. Document it in `docs/04-integrations.md` so future contributors do not drift into Mode C.
- Battery and foreground: the WebView must stay in the foreground; use `expo-keep-awake` during an assisted run and pause cleanly on background, re-saving the session through WS08's hook.
- Fixtures: capture with WS08's `(dev)/snapshot.tsx` and review the scrub list before committing; no account names, addresses, order numbers or card fragments in `__fixtures__`.
- Albertsons banners share one platform; a fixture per banner still matters because store locators and promo badges differ. Parameterize, do not fork.
- Desktop: the same adapters run on any `BrowserHost`; WS13 may add a Tauri host later. Keep adapters free of React Native imports.

## Completion report
End with the report format from `docs/implementation-guide.md` §6.2 (Message templates) (Built, Files changed, Verification output, Deviations from brief, Contract change requests, Open issues, Follow-ups). Nothing else is read by the orchestrator.

## Preconditions and follow-ups from the WS08 review (orchestrator, 2026-10-31)

Before the first screenshot upload: the 30-day lifecycle job in WS08's migration deletes `storage.objects` rows, which does not remove the file from the Storage backend. WS10 adds the sweep (an Edge Function or the worker calling `storage.remove` for objects past 30 days, scheduled by pg_cron through pg_net or run by the worker) and proves it with a test before any upload code lands. The consent copy promises deletion.

Also from that review, for WS10 to pick up:
- Call `configureAppTier3Gate` or `installTier3Gate` before `getAdapter`; wrap each run in `useTier3Session` (restore before, save with `clear: true` after); pass site-specific `signedInCheck` and `allowedHosts`; `looksSignedIn` has no host check today.
- `llm-proxy` requires a `runId` but does not check it against `shopping_runs`; once WS09 is merged, verify the run belongs to the caller's household so a fresh id per call cannot reset the per-run total.
- A `CONSENT_VERSION` bump needs a migration (`tier3_consent_version()`), and Settings hides Connect once a store is connected, so no screen offers re-consent for an already-connected store; add one with the first bump.
- `finishTier3SignIn` swallows a failed revoke after a failed seal, which can leave an active row with no blob; harmless (restore reports needs-sign-in, Disconnect works) but worth tightening.
- The Tier 3 connect belongs in onboarding step 7 as well as household settings.

