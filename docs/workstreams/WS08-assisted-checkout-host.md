# WS08: Assisted checkout host (Tier 3 WebView host, sessions, consent, gating)

**Wave:** 3 · **Suggested model:** Opus · **Branch:** `ws/08-assisted-checkout-host`

## Goal
When this is done, the app can open a retailer's own website inside a WebView on the user's device, read the page as a stable snapshot tree, click, type, select, wait and screenshot through an injected bridge, and keep the user's logged-in session across runs without ever seeing a password. A household that connects Safeway or Costco sees the consent screen once, at connect time, and the gate that every browser adapter must pass (`tier3Gate`) checks the PostHog kill switch and that consent. The on-device agent's model calls go through an Edge Function that holds the server key and enforces the household cost cap. This is the foundation of Tier 3, which is now the main path for Safeway, Albertsons, Haggen and Costco since Instacart's Developer Platform is closed to new applicants. WS10 builds the per-site adapters on top of this host; nothing in this WS knows about any retailer's page layout.

## Depends on
- WS07 (Retailer framework + Kroger): `RetailerAdapter`, typed errors (`RetailerNotSupportedError`, `RetailerAuthError`), `retailer_connections` with `auth_type = 'browser_session'`, the registry's `getAdapter()` hook this WS gates, and the Vault helpers for per-connection keys.
- WS01 (Auth & households): `households`, `household_members`, membership checks, the household settings and connect flow this WS adds screens to.
- WS00 (scaffold): `packages/llm` client and `logAiRun()`, PostHog client, Edge Function layout, `supabase/tests` pgTAP wiring.
- Human checkpoint 4: the consent copy in `apps/mobile/features/tier3/consent.ts` is approved and the list of retailers that get Tier 3 (default: Safeway, Albertsons, Haggen, Costco) is chosen. Do not start without it.
- Does not depend on WS09. The host, bridge, sessions, consent, gating and `llm-proxy` are testable against a static page without the agent loop.

## Read first
1. `docs/04-integrations.md` "Tier 3: browser automation" section (modes A, B, C and the common rules), then the Costco and Safeway, Albertsons, Haggen blocks (bot protection, terms clauses).
2. `docs/05-security-privacy.md` "Retailer credentials and sessions", "Money", "Audit", "Privacy".
3. `docs/06-risks.md` rows R16, R17, R19, R22.
4. `docs/03-ai-design.md` §8 Shopping agent (Tools, Policies enforced in code, Audit) and §1 Model tiers and plumbing (cost caps, `ai_runs`).
5. `docs/02-data-model.md` `households` row `tier3_consent`, `retailer_connections`, `ai_runs`.
6. `packages/retailers/src/types.ts`, `registry.ts` and `errors.ts` as merged from WS07; `packages/llm/src/` as merged from WS00.

## In scope
- **`BrowserHost` interface** in `packages/retailers/src/browser/host.ts`, platform-neutral, with `navigate`, `url`, `snapshot`, `click`, `type`, `select`, `waitFor`, `screenshot` and `onUserRequired`. `snapshot.ts` holds `SnapshotNode` and `SnapshotTree` plus the serializer contract the bridge implements: stable ids across calls on an unchanged DOM, role, accessible name, text, value, href and a bounding box per node, with a `maxNodes` cap.
- **Shared heuristics** in `packages/retailers/src/browser/skills.ts`: find by role and text, nearest button to a node, price parsing (`"$4.99"`, `"2 for $5"`, `"$0.31/oz"`), quantity stepper detection, visible-text normalization. Pure functions over `SnapshotTree`, no retailer knowledge.
- **WebView host** `apps/mobile/features/tier3/WebViewHost.tsx` backed by `react-native-webview`, plus `bridge.js`, the injected script. The bridge walks the DOM, assigns stable ids (a hash of role, name, DOM path and index), serializes the tree, performs clicks, typing and selects with real DOM events, resolves `waitFor` by polling, and posts messages over `postMessage`. It also watches for user-required conditions: a sign-in URL or password field (`login`), a node or iframe whose name matches `/captcha|verify you are human|press and hold/i` (`captcha`), a one-time-code field (`mfa`). The host raises `onUserRequired` with the reason; WS10 decides what to do.
- **Session handling**: the user logs in inside the WebView the first time. `secureSession.ts` persists only cookies and storage state for the retailer's domains, encrypted on device with a per-connection key held in Supabase Vault, in `expo-secure-store` keyed by connection id. The device obtains that key through the `connection_session_key(connection_id)` RPC below (security definer; the caller must be the connection's `user_id`); the key is created in Vault on the first call, held in memory for the run, and never written to disk unencrypted. Nothing session-related is stored on our servers in plaintext and no password is ever read, stored or autofilled. `useTier3Session.ts` restores the session into the WebView before a run and re-saves after. **Disconnect** wipes the WebView cookie store, deletes the secure-store entry, deletes the Vault key, and sets `retailer_connections.status = 'revoked'`.
- **Consent at connect**: `ConsentScreen.tsx` renders the approved copy from `consent.ts` (`CONSENT_VERSION`, retailer names, the terms-of-service and account exposure, what is and is not stored). It is shown once when a household connects Safeway or Costco (or any Tier 3 retailer) from the connect flow, not from settings. It cannot be dismissed without scrolling to the end and checking the acknowledgment. Accepting writes `households.tier3_consent` through a security-definer function and continues to the login WebView. A later connect for a retailer already in `retailers[]` skips the screen; a new retailer or a newer `CONSENT_VERSION` shows it again.
- **Gating** in `packages/retailers/src/browser/gating.ts`: `tier3Gate(householdId, retailer)` resolves when PostHog flag `tier3_browser_checkout` is on (it defaults on; it is a kill switch, not an opt-in) AND `households.tier3_consent.retailers` includes the retailer AND `copy_version` matches `CONSENT_VERSION`. Otherwise it throws `RetailerNotSupportedError` with a reason code (`flag_off`, `no_consent`, `stale_consent`). The registry calls it before constructing any adapter whose `auth_type` is `browser_session`.
- **`llm-proxy` Edge Function** `supabase/functions/llm-proxy/index.ts`: accepts the on-device agent's model requests (messages, tools, model id) from an authenticated household member, forwards them to Anthropic with the server-side key, enforces `households.ai_daily_cap_usd` and the per-run cap through `packages/llm`, writes an `ai_runs` row per call, streams the response back. The app bundle never holds the Anthropic key. This WS owns the function; WS09's worker uses `packages/llm` directly and does not need it.
- **Migration** `supabase/migrations/<timestamp>_ws08_tier3.sql`: `households.tier3_consent jsonb` with a check constraint on shape `{accepted_at, by_user_id, retailers[], copy_version}`; `record_tier3_consent(household_id, retailers text[], copy_version text)` security-definer function that verifies membership and merges the passed retailers into the stored `retailers[]` (union, never replace) while setting `copy_version`, `accepted_at` and `by_user_id`; `connection_session_key(connection_id)` and `revoke_browser_connection(connection_id)` security-definer functions for the on-device session key (see Interfaces); Storage bucket `run-screenshots` (private) with RLS so a household reads only `<runId>` prefixes that belong to its runs and the service role writes; a 30-day lifecycle rule. No UPDATE grant on the new column for `authenticated` (see Risks and notes).
- **RLS tests** `supabase/tests/ws08_tier3_rls.sql` (pgTAP): consent function membership checks, column privileges, bucket policies.
- **Dev snapshot capture tool** `apps/mobile/app/(dev)/snapshot.tsx`: opens any URL in the host, shows the serialized tree, scrubs personal data (emails, names, addresses, card fragments, order numbers) with a reviewable list of replacements, and saves `*.snapshot.json` to the device share sheet so WS10 can commit fixtures.
- **Mode B section** in `services/shopper-worker/README.md`: how a household-hosted Playwright worker (Mac mini or home server with a persistent profile) would implement `BrowserHost` and plug into the same adapters, and why it is not built now (no second host to test, no distribution story, terms exposure moves off the user's device). Document only.
- Tests: bridge tests with a mocked WebView, snapshot id stability, skills unit tests, session encryption and wipe tests, consent screen tests, gating tests, `llm-proxy` cap and logging tests.

### Bridge message protocol

| Direction | Message | Payload |
|---|---|---|
| host → page | `navigate` | `{ url }` (host-side `source` change; bridge re-injects on load) |
| host → page | `snapshot` | `{ requestId, maxNodes }` |
| page → host | `snapshot.result` | `{ requestId, tree: SnapshotTree }` |
| host → page | `click` / `type` / `select` | `{ requestId, nodeId, text?, value?, clear? }` |
| page → host | `action.result` | `{ requestId, ok, error? }` |
| host → page | `waitFor` | `{ requestId, timeoutMs }` (host evaluates the predicate on each `snapshot.result` the bridge streams at 250 ms until resolved or timed out) |
| page → host | `userRequired` | `{ reason: 'login' \| 'captcha' \| 'mfa' \| 'unexpected', nodeId?, url }` |
| page → host | `navigated` | `{ url, title }` on every history or location change |

Screenshots are taken host-side with `react-native-view-shot` on the WebView (JPEG, quality 60) and returned as `Uint8Array`; the bridge is not involved. `pay` is not a bridge reason; WS10 raises it from its checkout recipe.

### Session lifecycle

| Step | Where | What is stored |
|---|---|---|
| Connect tapped for a Tier 3 retailer | connect flow | nothing yet |
| Consent accepted | `record_tier3_consent` | `households.tier3_consent` |
| User signs in inside the WebView | WebView | retailer cookies in the WebView's store (device only) |
| Sign-in detected (account menu present, sign-in URL gone) | `useTier3Session.ts` | cookies and storage state read, encrypted with the connection's Vault key, written to `expo-secure-store`; `retailer_connections` row with `auth_type = 'browser_session'`, `status = 'active'`, no token columns filled |
| Run starts (WS10) | `useTier3Session.ts` | secure-store blob decrypted and injected before first navigation |
| Run ends or app backgrounds | `useTier3Session.ts` | blob re-saved if cookies changed |
| Session expired (sign-in page appears) | bridge `userRequired: login` | user signs in again; blob replaced |
| Disconnect | `secureSession.ts` | WebView cookies cleared, secure-store entry deleted, Vault key deleted, `status = 'revoked'` |

## Out of scope
- Any retailer adapter, page skill, or site recipe for Safeway, Albertsons, Haggen, Costco or Kroger (WS10). This WS is tested against a public static test page only.
- The assisted run screen, pause banners, pay-step gate and screenshot upload per tool call (WS10). This WS creates the bucket and the `screenshot()` primitive; WS10 writes to the bucket.
- The agent loop, tools, run state machine and review UI (WS09).
- Mode C, cloud headless browsers. Forbidden. No Playwright or Puppeteer dependency anywhere; the only mention is the Mode B README section.
- Residential proxies, fingerprint spoofing, CAPTCHA solving, or any bot-detection evasion.
- Storing retailer passwords anywhere, or autofilling them. Password managers in the WebView are the OS's business, not ours.
- instacart.com. Instacart is not a supported retailer.
- Changing `RetailerAdapter`, `packages/core` types, or `retailer_connections` columns. File a contract change request.
- A Tauri or web implementation of `BrowserHost` (WS13 later; keep `host.ts` platform-neutral).

## Deliverables
- `packages/retailers/src/browser/host.ts`, `snapshot.ts`, `skills.ts`, `gating.ts`, `index.ts`.
- `packages/retailers/src/browser/skills.test.ts`, `snapshot.test.ts`, `gating.test.ts`.
- `packages/retailers/src/browser/__fixtures__/static-test-page.snapshot.json` captured from the test page below.
- `apps/mobile/features/tier3/WebViewHost.tsx`, `bridge.js`, `ConsentScreen.tsx`, `consent.ts`, `useTier3Session.ts`, `secureSession.ts`, `index.ts`.
- `apps/mobile/features/tier3/__tests__/bridge.test.ts`, `secureSession.test.ts`, `ConsentScreen.test.tsx`, `useTier3Session.test.ts`.
- `apps/mobile/features/tier3/test-page/index.html`: a static page with a search box, a results grid of 10 tiles with prices and Add buttons, a quantity stepper, a select, a slow-appearing node for `waitFor`, and a fake sign-in form. Served from a public static host for the simulator demo (Cloudflare Pages or GitHub Pages; URL recorded in the report) and loaded from the bundle in tests.
- Connect flow change: `apps/mobile/features/retailers/connect/` gains a Tier 3 branch that shows `ConsentScreen` then the login WebView for retailers whose adapter `auth_type` is `browser_session`, and a Disconnect action on the connection row.
- `apps/mobile/app/(dev)/snapshot.tsx`.
- `supabase/functions/llm-proxy/index.ts` and `supabase/functions/llm-proxy/index.test.ts`.
- `supabase/migrations/<timestamp>_ws08_tier3.sql`.
- `supabase/tests/ws08_tier3_rls.sql`.
- `services/shopper-worker/README.md` Mode B section (create the README if WS09 has not merged yet; WS09 keeps the rest of the file).
- `.env.example` additions: `EXPO_PUBLIC_POSTHOG_KEY` if absent, `LLM_PROXY_MAX_TOKENS_PER_CALL`, `TIER3_TEST_PAGE_URL`.
- Docs update: `docs/04-integrations.md` Tier 3 section gains the bridge message protocol and the user-required reasons as built; `docs/05-security-privacy.md` "Retailer credentials and sessions" gains the session key RPC and the exact disconnect sequence. Nothing else in `docs/`.

## Interfaces
**Implements**
- `BrowserHost`, `SnapshotNode`, `SnapshotTree`:
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
    onUserRequired(cb: (reason: 'captcha' | 'mfa' | 'login' | 'unexpected') => void): void; // 'pay' and 'membership' are WS10 pause reasons, raised by recipes, not the host
  }
  interface SnapshotNode { id: string; role: string; name: string; text?: string; value?: string; href?: string; bbox: [number, number, number, number]; children?: SnapshotNode[]; }
  type SnapshotTree = { url: string; title: string; root: SnapshotNode; capturedAt: string };
  ```
- `skills.ts`: `findByRole(tree, role, nameMatch?)`, `findByText(tree, match)`, `nearestButton(tree, nodeId, nameMatch?)`, `parsePrice(text): { amount: number; unit?: string } | null`, `findStepper(tree, nodeId)`, `normalizeText(s)`.
- `tier3Gate(householdId: string, retailer: string): Promise<void>` and `isTier3Allowed(householdId, retailer): Promise<{ ok: true } | { ok: false; reason: 'flag_off' | 'no_consent' | 'stale_consent' }>`.
- `secureSession.ts`: `saveSession(connectionId, state: SessionState)`, `loadSession(connectionId): Promise<SessionState | null>`, `wipeSession(connectionId)`. `SessionState = { cookies: Cookie[]; localStorage: Record<string, string>; sessionStorage: Record<string, string>; savedAt: string }`. No field may hold a password; the type has none and the test asserts the blob does not contain the test password.
- `consent.ts`: `CONSENT_VERSION: string`, `CONSENT_COPY: { title, sections: { heading, body }[], acknowledgment }`, `TIER3_RETAILERS: readonly string[]`.
- SQL: `households.tier3_consent jsonb` `{ accepted_at timestamptz, by_user_id uuid, retailers text[], copy_version text }`; `record_tier3_consent(household_id uuid, retailers text[], copy_version text) returns jsonb` (security definer, membership-checked; merges `retailers` into the stored array and returns the new column value); `connection_session_key(connection_id uuid) returns text` (security definer; raises unless `auth.uid() = retailer_connections.user_id` and `auth_type = 'browser_session'`; creates the Vault secret and sets `vault_secret_id` on first call, returns the decrypted key afterwards; never readable through `vault.decrypted_secrets` by `authenticated`); `revoke_browser_connection(connection_id uuid) returns void` (same ownership check; deletes the Vault secret, nulls `vault_secret_id`, sets `status = 'revoked'`); Storage bucket `run-screenshots` with policies `select` for household members on their run prefixes and `insert`/`delete` for the service role; lifecycle 30 days.
- Edge Function `POST /functions/v1/llm-proxy` body `{ householdId, runId?, kind: 'agent.plan' | 'agent.step', model, system, messages, tools?, maxTokens }`; streams the Anthropic response; 402 with `{ error: 'cost_cap' }` when the household's daily cap or the run's cap would be exceeded; writes `ai_runs (kind, model, input_tokens, output_tokens, cost_usd, household_id, run_id)`.
- `apps/mobile/app/(dev)/snapshot.tsx` dev route, present only in dev builds.

**Consumes**
- `RetailerAdapter`, `RetailerNotSupportedError`, `RetailerAuthError`, registry `getAdapter()` and its pre-construct hook (WS07).
- `retailer_connections (household_id, user_id, retailer, auth_type, status, store_id, vault_secret_id)` (WS07); the Vault pattern from WS07's `retailer-oauth` function (`vault.create_secret`, `vault.decrypted_secrets`) as the model for the two RPCs above.
- `households`, `household_members`, `households.ai_daily_cap_usd` (WS01, WS15 default).
- `packages/llm`: `createClient()`, `logAiRun()`, cost table (WS00).
- PostHog flag `tier3_browser_checkout` (default on); `react-native-webview`; `expo-secure-store`; `react-native-view-shot`; Supabase Storage.

**Facts the implementation must respect**
- Costco: Kasada bot protection on Akamai; plain curl got HTTP 429. Terms bar "applications or software that interact with our Services without our prior written consent" and bar sharing account credentials; the member is responsible for the account.
- Safeway/Albertsons: Imperva plus Akamai. Terms §18 bar access "through any means other than the visual user interfaces," any automated system, and commercial use without approval.
- Amazon v. Perplexity (appeals court, Aug 2026) vacated an injunction on the reasoning that the user, not the agent vendor, accessed the site; contract claims survive. The user is the one acting; the app assists. Keep the user's device, cookies, and residential IP in the loop, and never run unattended in the cloud.
- `households` columns are granted to `authenticated` by name (`name`, `zip`). A new column is not client-editable unless a migration grants it. Do not grant `tier3_consent`; write it through `record_tier3_consent`.

## Acceptance criteria
1. `pnpm typecheck && pnpm lint` pass. `grep -rn "playwright\|puppeteer" packages services apps supabase --include=*.ts --include=*.tsx --include=*.js --include=package.json` returns only the `services/shopper-worker/README.md` Mode B section.
2. Dev screen demo on the iOS Simulator: `(dev)/snapshot.tsx` loads `TIER3_TEST_PAGE_URL`, and a scripted sequence through the bridge performs `navigate`, `snapshot`, `click` on the third tile's Add button, `type` "oat milk" into the search box, `waitFor` the slow node, and `screenshot`. Each step's result is shown on screen. Record a screen recording path in the report.
3. `snapshot.test.ts` and `bridge.test.ts` (mocked WebView over the bundled test page): every node has `id`, `role`, `name`, `bbox` with four finite numbers; `snapshot()` returns identical ids across two calls on an unchanged DOM; after typing into the search box only that node's `value` changes; `maxNodes: 50` returns at most 50 nodes and marks truncation; `click` and `type` post the expected messages and resolve on `action.result`.
4. `bridge.test.ts`: `onUserRequired('captcha')` fires when a node with role `iframe` and name matching `/captcha|verify you are human/i` appears; `onUserRequired('login')` fires when a password field appears; `onUserRequired('mfa')` fires when an input with `autocomplete="one-time-code"` appears.
5. `skills.test.ts`: `parsePrice` handles `"$4.99"`, `"2 for $5.00"`, `"$0.31/oz"`, `"Was $6.49 Now $4.99"` (returns the current price); `nearestButton` picks the Add button inside the same tile, not the neighbor's; `findStepper` finds plus, minus and the count node.
6. `ConsentScreen.test.tsx`: the continue button is disabled until the content is scrolled to the end and the acknowledgment is checked; accepting calls `record_tier3_consent` with the retailer and `CONSENT_VERSION`; accepting for `costco` after `safeway` leaves both in `retailers[]`; the connect flow for `safeway` shows `ConsentScreen` for a household with no consent and skips it for a household whose `retailers[]` already includes `safeway` at the current version; a bumped `CONSENT_VERSION` shows it again.
7. `gating.test.ts`: flag off → `RetailerNotSupportedError` (`flag_off`); flag on, no consent → `no_consent`; flag on, consent for `costco` only, asking for `safeway` → `no_consent`; consent at an older `copy_version` → `stale_consent`; flag on and matching consent → resolves and `getAdapter('safeway')` reaches construction (with a stub adapter registered for the test).
8. `secureSession.test.ts`: after a simulated sign-in on the test page, `saveSession` writes one `expo-secure-store` entry keyed by connection id; the entry is ciphertext (no substring of the test password, no cookie name in plaintext); `loadSession` round-trips; `wipeSession` removes the entry, clears WebView cookies (mock asserts the call), deletes the Vault key, and `retailer_connections.status` becomes `revoked`.
9. `llm-proxy/index.test.ts`: a request from a non-member returns 403; a request under the cap is forwarded with the server key and writes one `ai_runs` row with `cost_usd > 0`; a request that would exceed `ai_daily_cap_usd` returns 402 `cost_cap` and writes no forwarding call; the Anthropic key never appears in any response body or log line.
10. `supabase test db` passes `ws08_tier3_rls.sql`: `record_tier3_consent` succeeds for a member and raises for a non-member, and two calls with different retailers produce the union; `connection_session_key` returns the same key on two calls for the owning user, raises for another member of the same household, and `authenticated` cannot select from `vault.decrypted_secrets`; `revoke_browser_connection` deletes the secret and sets `revoked`; `column_privs_are('public', 'households', 'tier3_consent', 'authenticated', ARRAY['SELECT'])`; a member of household A cannot list or read objects under household B's run prefix in `run-screenshots`; the service role can insert; the bucket's lifecycle rule is 30 days.
11. The `(dev)` snapshot route is excluded from production builds (`grep` on the production bundle manifest finds no `snapshot` route).
12. `pnpm test --filter retailers -- browser` and `pnpm test --filter mobile -- tier3` are green; Biome reports no issues.

## Verification commands
```bash
pnpm typecheck && pnpm lint                                   # expected: exit 0
grep -rn "playwright\|puppeteer" packages services apps supabase --include=*.ts --include=*.tsx --include=*.js --include=package.json   # expected: README only
pnpm test --filter retailers -- browser                       # expected: snapshot, skills, gating tests green
pnpm test --filter mobile -- tier3                            # expected: bridge, secureSession, ConsentScreen, useTier3Session tests green
supabase start && supabase db reset && supabase test db       # expected: ws08 migration applies; run-screenshots bucket exists; ws08_tier3_rls.sql passes
supabase functions serve llm-proxy --env-file .env.local &
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:54321/functions/v1/llm-proxy \
  -H "Authorization: Bearer $TEST_USER_JWT" -H "Content-Type: application/json" \
  -d '{"householdId":"<fixture>","kind":"agent.step","model":"claude-haiku-5-5","system":"ping","messages":[{"role":"user","content":"ping"}],"maxTokens":16}'   # expected: 200, then one ai_runs row
psql "$SUPABASE_DB_URL" -c "select kind, model, cost_usd from ai_runs order by created_at desc limit 1;"   # expected: agent.step row
pnpm --filter mobile start                                    # manual: (dev)/snapshot demo against TIER3_TEST_PAGE_URL; connect Safeway → ConsentScreen → login WebView → Disconnect
```

## Risks and notes
- From the WS01 review (2026-10-30): `households` columns are granted to `authenticated` by name (`name`, `zip`). Do not grant UPDATE on `tier3_consent`; write it through `record_tier3_consent` (security definer, membership-checked) and add the `column_privs_are` pgTAP assertion. This satisfies the orchestrator's note that WS10-era columns must not become client-editable.
- R16: bot detection. Mode A runs in a real WebView on the user's device with the user's cookies and IP, which is the lowest-risk posture available. Kasada and Imperva may still challenge; the bridge detects it and raises `captcha`, and the human clears it. Never add evasion. Do not modify the WebView user agent.
- R17: terms. Costco and Albertsons both prohibit this in their terms; the exposure is the user's account. Consent is shown once at connect, names each retailer, states the exposure plainly, and is versioned. The flag is a kill switch (default on), not the consent mechanism. Consent is.
- R19: Tier 3 is the only route to hands-off checkout. This WS makes the host trustworthy enough that WS10 can promise "with your final tap". `auto_checkout` stays off by default and is WS09's policy, not this WS's.
- R22: commercial use. Albertsons' terms bar commercial use without approval; the consent copy says Tier 3 is for the household's personal shopping only.
- Session security: the Vault key never reaches the device in plaintext storage; it is fetched per use and held in memory. If `expo-secure-store` is unavailable (simulator without keychain), fail closed and ask the user to sign in each run; never fall back to AsyncStorage.
- Cookie domains: persist only cookies for the retailer's registered domains (`safeway.com`, `albertsons.com`, `haggen.com`, `costco.com`, and their subdomains). Drop third-party cookies.
- Bridge injection timing: `injectedJavaScriptBeforeContentLoaded` plus re-injection on every `onLoadEnd`, since SPA navigations do not reload. Guard against double injection.
- Stable ids: DOM-path based ids break when the site inserts a banner. Use a hash of role, accessible name and sibling index of same-role nodes, and fall back to the DOM path only for anonymous nodes. Fixture tests prove stability across a reload of the same page.
- `waitFor` predicates run host-side over streamed snapshots, so a predicate must be cheap; cap snapshot size with `maxNodes` during waits.
- The `(dev)` route and the static test page must not resemble any retailer's site or use any retailer mark.
- Mode B is documented so nobody builds Mode C by mistake. The README section states plainly that a cloud headless host is forbidden.
- Desktop: the same `BrowserHost` can be implemented for the Tauri build with a webview window in WS13 later; keep `host.ts` free of React Native imports.

## Completion report
End with the report format from `docs/implementation-guide.md` §6.2 (Message templates) (Built, Files changed, Verification output, Deviations from brief, Contract change requests, Open issues, Follow-ups). Nothing else is read by the orchestrator.

## Orchestrator corrections (2026-10-31, before dispatch)

These override the sections above where they differ. Checkpoint 4 passed on 2026-10-31: Miguel approved the consent copy in `docs/08-brand.md` §11 as drafted and the four stores.

1. **Consent copy and version.** `consent.ts` carries the approved copy from `docs/08-brand.md` §11 verbatim (title, five sections, acknowledgment), with `{store}` filled at render time by the display name of the banner being connected. `CONSENT_VERSION = "2026-10-31"`. Haggen is named on the screen, as drafted.
2. **Retailer ids versus banners.** `RetailerId` (`packages/core/src/retail.ts`) has `safeway` and `costco`; Albertsons and Haggen are banners of `safeway`, the way QFC and Fred Meyer are banners of `kroger` (`BANNERS` in `packages/retailers`). So `TIER3_RETAILERS` is the id list `["safeway", "costco"]`, `households.tier3_consent.retailers` stores ids, and a separate display list names Safeway, Albertsons, Haggen and Costco in the copy and the connect flow. `instacart` is still in `RetailerId` for now; never reference it. Add nothing to `RetailerId`.
3. **Files and versions.** Migration `supabase/migrations/20261031110000_ws08_tier3.sql` (WS09 holds `20261031100000`); pgTAP `supabase/tests/ws08_tier3_rls.sql`, counts scoped to your fixtures because `db reset` seeds 62 catalog recipes. `households` policies are pinned with `policies_are` in `001_rls_identity.sql`; you add no policy there (consent is written through the security-definer function), and if you add any policy to a pinned table you update the pin in the same commit. The bucket follows the `insert into storage.buckets` pattern in `20261030090000_recipes.sql`; the Vault pattern is in `20261030100000_ws07_retail.sql`.
4. **App paths.** Features live under `apps/mobile/src/features/`, not `apps/mobile/features/`. Yours: `apps/mobile/src/features/tier3/` (and `__tests__/` inside it). The connect flow is `apps/mobile/src/features/retailers/` (`ConnectKroger.tsx`, `ConnectionCard.tsx`, `useRetailerConnection.ts`): add `ConnectTier3.tsx` beside `ConnectKroger.tsx`, wire it where the Kroger connect is offered, and give `ConnectionCard.tsx` the Disconnect action for `browser_session` connections. Those two existing files are the only WS07 UI files you may edit, minimally and disclosed. The `(dev)` route group exists at `apps/mobile/app/(dev)/`.
5. **Registry gate.** `packages/retailers/src/registry.ts` has no pre-construct hook. Add one as new code only: `AdapterRegistry.setGate(fn)` where `fn(retailerId)` may throw `RetailerNotSupportedError`, called inside `getAdapter` when a gate is set, with behaviour unchanged when none is set, plus a test. Everything else you add to `packages/retailers` lives under `src/browser/` with export lines in `src/index.ts`. Do not touch `types.ts`.
6. **Cost cap.** `households.ai_daily_cap_usd` does not exist (WS15 adds it). `llm-proxy` enforces the daily cap the way `supabase/functions/suggest/` does: `createDailyCapGuard` from `@mp/llm` with `AI_DAILY_CAP_USD` from the environment, plus your per-run cap from the request. Do not add the column. `ai_runs.kind` values are `agent_plan` and `agent_step` (underscore), the same as WS09; use the same strings in the request body.
7. **`packages/llm` as built.** `createAnthropicClient(options)` returning a `MessagesClient` (not `createClient()`), `logAiRun`, `toAiRunRow`, `estimateCostUsd`, `createDailyCapGuard`, `MODELS`. The proxy forwards raw Messages API requests, so if `MessagesClient` is too narrow, call the Anthropic SDK directly inside the function with the server key and still write the `ai_runs` row through `logAiRun`.
8. **PostHog.** The app has only the `EXPO_PUBLIC_POSTHOG_KEY` env binding (`apps/mobile/src/lib/env.ts`); no client library is installed. Put the flag lookup behind a small `flags.ts` interface in `features/tier3/` with a PostHog implementation (`posthog-react-native`, one dependency, disclosed). The flag is a kill switch: it is on when the key is absent, when PostHog cannot be reached, or when PostHog says on; it is off only when PostHog says off. WS15 may move the client later.
9. **Native modules and the Simulator.** `react-native-webview`, `expo-secure-store` and `react-native-view-shot` are not installed; add them with `npx expo install`. They need a dev build, not Expo Go. Xcode is at `/Applications/Xcode.app` and an iPhone 17 Pro Simulator is booted; try `npx expo run:ios` from `apps/mobile` for criteria 2 and 11. If the native build fails on the toolchain (CocoaPods, signing, first-launch components), paste the exact error, stop trying, and judge criterion 2 from the mocked-WebView bridge tests, leaving it open in your report.
10. **Test page hosting.** No public static host exists yet. Commit the page at `apps/mobile/src/features/tier3/test-page/index.html`, serve it locally for tests and the Simulator demo (a static server on a fixed port; the Simulator reaches `localhost`), and set `TIER3_TEST_PAGE_URL` in `.env.example` with a comment that a public URL replaces it later. The page must not resemble any retailer's site or use any retailer mark.
11. **Mode B text.** WS09 is building in `services/shopper-worker/` right now, so do not touch that directory or `packages/agent/`. Write the Mode B section into the Tier 3 part of `docs/04-integrations.md` (which you already update) instead of the worker README, with the same content: how a household-hosted Playwright worker would implement `BrowserHost`, why it is not built, and that a cloud headless host is forbidden.
12. **Service role.** `llm-proxy` does not need SQL beyond PostgREST; use the service-role client for the `ai_runs` write after verifying the caller with `auth.getUser` and membership, as `list-build` and `suggest` do. If you do connect over `SUPABASE_DB_URL`, every transaction runs `set local role service_role` first, with a test that DDL fails.
13. **This machine and CI.** No container runtime: `supabase start`, `db reset`, `test db`, `functions serve`, `psql` and the Vault RPCs cannot run locally; CI is the authority (migrations, pgTAP, `deno check`). For local SQL use the PGlite harness pattern in `supabase/functions/list-build/testing/` with the Vault stubs noted in `supabase/functions/suggest/testing/db.ts`. Never read or print `.env.local`. Before your report, `git fetch origin && git merge origin/main`; WS09 may have landed.
14. **Report.** Evidence per criterion with real output, the CI run id, which criteria could not run here and why, and every file outside the Deliverables you touched.

