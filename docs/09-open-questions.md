# 09 · Open questions

Facts the research could not confirm as of 2026-10-29, who can resolve each, and when to re-check. The orchestrator assigns a researcher agent or asks the human; answers go into the decisions log in `status.md` and the relevant doc is updated.

## Kroger

| Question | Why it matters | How to resolve | When |
|---|---|---|---|
| Can the Products quota be raised for a fee without a Partner contract? Terms imply yes; no pricing published | Headroom beyond one household | Human asks via the portal contact form | Before public beta |
| Is `nutritionInformation` populated in Products responses? Schema lists it; the FAQ says unsupported | Whether nutrition display can come from Kroger | Builder inspects live responses in WS07 | WS07 |
| Written clarification on storing user-pinned product preferences and run history under the "no storing data derived from searches or cart adds" clause (R21) | API revocation risk; price-trend feature | Human emails Kroger developer support with the specific design | Before public beta |
| Is the Partner tier reachable for a small app? | Full cart CRUD, no rate limits | Human files a Partner Request after v1 works | After Phase 2 |
| Exact QFC and Fred Meyer `locationId` coverage and the `banner` values beyond `qfc` and `fredmeyer` | Store picker | Builder queries Locations in WS07 | WS07 |

## Costco and Albertsons

| Question | Why it matters | How to resolve | When |
|---|---|---|---|
| Audience of `doc.api.digital.costco.com` (redirect-looped during research) | A hidden partner API would change Costco's tier | Researcher agent re-checks; human may ask Costco | Before WS10 |
| Outcome of Albertsons v. Kroger in Delaware Chancery (trial began 2026-10-19) | No product impact; may change Albertsons' partner posture | Researcher agent re-checks | Quarterly |
| Albertsons' plan to extend the ChatGPT experience to other banners, and whether any third-party surface opens | A sanctioned path for Safeway would replace the browser adapter | Researcher agent re-checks | Quarterly |
| Does costco.com offer grocery pickup or delivery in the household's area without Instacart? | Sets what the Costco adapter can do beyond warehouse items | Builder checks on a member account during WS10 | WS10 |

## Agentic commerce

| Question | Why it matters | How to resolve | When |
|---|---|---|---|
| When does any grocer accept third-party buyer agents over UCP/AP2 or ACP? | Would replace Tier 3 with a sanctioned checkout | Researcher agent re-checks ucp.dev, ACP repo, Kroger and Albertsons newsrooms | Quarterly |
| Does Instacart's Developer Platform reopen, or offer a cart-write tier to small apps? | Would bring back a sanctioned route for Safeway and Costco | Researcher agent checks company.instacart.com/business/developers | Quarterly |

## Stack

| Question | Why it matters | How to resolve | When |
|---|---|---|---|
| Timeline for `react-native-macos` to catch up to RN 0.86+ | Could reopen a native desktop path instead of Tauri | Researcher agent | Before WS13 |
| Percentage of recipe sites emitting Recipe JSON-LD (only absolute counts found) | Sets expectations for the import fallback rate | The WS02 golden set measures it for us | WS02 |

## Product

| Question | Why it matters | How to resolve | When |
|---|---|---|---|
| Name | Branding, domains, store listing | Human picks after checks (checkpoint 6) | WS14 |
| Tier 3 deployment: Mode A only, or also Mode B on a home server | Unattended scheduled checkout | Decided 2026-10-30: Mode A in v1, Mode B document-only. Revisit after Phase 3 | After Phase 3 |
