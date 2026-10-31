# 09 · Open questions

Facts the research could not confirm as of 2026-10-29, who can resolve each, and when to re-check. The orchestrator assigns a researcher agent or asks the human; answers go into the decisions log in `status.md` and the relevant doc is updated.

## Instacart

| Question | Why it matters | How to resolve | When |
|---|---|---|---|
| Is the Developer Platform accepting new applicants? The marketing page said no; the docs said "Apply today" | Gates WS08 production and Tier 2 for Costco and Safeway | Human submits the application and records the reply | Week one |
| Does `?retailer_key=` on the generated URL preselect the store? One researcher found it in the tutorial; another could not | Determines whether we can send the user straight to Costco or Safeway | Builder tests with a dev key during WS08 | WS08 |
| Can a small app reach the partner MCP tier that manages carts? | Would upgrade Instacart from handoff to cart write | Human contacts Instacart via the developers page | After WS08 |
| Rate limits and affiliate commission rates | Cost model and call budgeting | Ask during the production review | WS08 approval |
| Behavior for unmatched ingredients on the landing page | UX copy for the hand-off | Observe with a dev key | WS08 |

## Kroger

| Question | Why it matters | How to resolve | When |
|---|---|---|---|
| Can the Products quota be raised for a fee without a Partner contract? Terms imply yes; no pricing published | Headroom beyond one household | Human asks via the portal contact form | Before public beta |
| Is `nutritionInformation` populated in Products responses? Schema lists it; the FAQ says unsupported | Whether nutrition display can come from Kroger | Answered 2026-10-30 (WS07): yes for the products checked, with an ingredient statement, serving size, and nutrients. Not mapped into `Product`; nothing uses it yet | Done |
| Written clarification on storing user-pinned product preferences and run history under the "no storing data derived from searches or cart adds" clause (R21) | API revocation risk; price-trend feature | Human emails Kroger developer support with the specific design | Before public beta |
| Is the Partner tier reachable for a small app? | Full cart CRUD, no rate limits | Human files a Partner Request after v1 works | After Phase 2 |
| Which daily quotas bind? Observed 2026-10-30 (WS07) in `x-ratelimit-limit-day` and `x-ratelimit-remaining-day`: Products 10,000, Locations 5,000, Chains 5,000. The published docs say 1,600 per Locations endpoint. `ratelimit-reset` counts down to 00:00 UTC, so the quota day is the UTC day. Cart and Identity headers not seen yet | `quota.ts` keeps the published 1,600 for Locations and adopts any lower number a header reports | Human asks Kroger which number binds; builder records Cart and Identity headers on the first live cart call | Before public beta |
| Will Kroger ever send cache headers? Observed 2026-10-30 (WS07): token, Locations, Chains, and Products responses carry no `Cache-Control` and no `Expires` | Under the "no caching past headers" rule nothing may be cached, so every lookup re-reads prices and spends quota | Re-check after Kroger API changes; ask Kroger whether a short in-run cache is acceptable | Before public beta |
| Does a refresh invalidate the previous refresh token, and does `PUT /v1/cart/add` limit items per request? | If a used refresh token dies, two processes refreshing one connection at once race: one rotates Vault, the other gets `invalid_grant`. The loser re-reads Vault (at once, then after 500 ms) and retries once with the winner's token before it flags `needs_reauth`. Cart adds are chunked at 50 items | Builder observes on the live cart test with the developer's own account | First live cart test |
| Exact QFC and Fred Meyer `locationId` coverage and the `banner` values beyond `qfc` and `fredmeyer` | Store picker | Partly answered 2026-10-30 (WS07): Locations returns chain `QFC` and `FRED` with 8-character ids (`705...` QFC, `701...` Fred Meyer); 20 such stores within 30 miles of 98019. `/chains` lists 46 chain names. Other `banner` values on the authorize URL were not tried | Before onboarding other banners |

## Costco and Albertsons

| Question | Why it matters | How to resolve | When |
|---|---|---|---|
| Audience of `doc.api.digital.costco.com` (redirect-looped during research) | A hidden partner API would change Costco's tier | Researcher agent re-checks; human may ask Costco | Before WS10 |
| Outcome of Albertsons v. Kroger in Delaware Chancery (trial began 2026-10-19) | No product impact; may change Albertsons' partner posture | Researcher agent re-checks | Quarterly |
| Albertsons' plan to extend the ChatGPT experience to other banners, and whether any third-party surface opens | Would create a Tier 2 path for Safeway | Researcher agent re-checks | Quarterly |

## Agentic commerce

| Question | Why it matters | How to resolve | When |
|---|---|---|---|
| When does any grocer accept third-party buyer agents over UCP/AP2 or ACP? | Would replace Tier 3 with a sanctioned checkout | Researcher agent re-checks ucp.dev, ACP repo, Kroger and Instacart newsrooms | Quarterly |
| Status of Instacart's Instant Checkout in ChatGPT after OpenAI's March 2026 pivot | Signals Instacart's appetite for agent checkout | Researcher agent | Quarterly |

## Stack

| Question | Why it matters | How to resolve | When |
|---|---|---|---|
| Timeline for `react-native-macos` to catch up to RN 0.86+ | Could reopen a native desktop path instead of Tauri | Researcher agent | Before WS13 |
| Percentage of recipe sites emitting Recipe JSON-LD (only absolute counts found) | Sets expectations for the import fallback rate | The WS02 golden set measures it for us | WS02 |

## Product

| Question | Why it matters | How to resolve | When |
|---|---|---|---|
| Name | Branding, domains, store listing | Human picks after checks (checkpoint 6) | WS14 |
| Tier 3 deployment: Mode A only, or also Mode B on a home server | Unattended scheduled checkout | Human decides during WS10 | WS10 |
- **Recipe catalog cold start.** Resolved 2026-10-30 by Miguel: a starter catalog. WS16 drafts at least 60 original dinner recipes with Sonnet from a coverage spec, parses them against the ontology, and seeds them as `visibility = catalog`. Miguel reviews the content before it loads into the hosted project. Import-first onboarding stays a fallback idea if the catalog proves thin.

## Recipe import

| Question | Why it matters | How to resolve | When |
|---|---|---|---|
| Do the recipe sites that return 403 to a Node fetch (allrecipes, seriouseats, simplyrecipes, budgetbytes, cookieandkate, sallysbakingaddiction; foodnetwork also under Deno) block Supabase Edge egress too? Deno read most of them from the development machine during WS02 | Decides how often URL import for popular sites falls to the model path or fails outright | Orchestrator probes from the hosted `recipe-import` function once the release lands and records per-domain results in the decisions log | After the hosted release |
